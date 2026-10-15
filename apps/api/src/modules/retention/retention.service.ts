import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Advisory-lock namespace for retention tasks (any constant unique within OGC). */
const LOCK_NAMESPACE = 0x6f7274; // "ort"

export type RetentionTask = 'sessions' | 'verificationTokens' | 'resetTokens' | 'auditEvents';
export type RetentionReport = Record<RetentionTask, number>;

const TASKS: readonly RetentionTask[] = [
  'sessions',
  'verificationTokens',
  'resetTokens',
  'auditEvents',
];

/**
 * Operational cleanup (docs/operations/data-retention.md). Each task deletes only rows that
 * are finished *and* older than its retention period — ended sessions, used or expired
 * tokens, old audit events — in bounded batches, skipping accounts under a retention hold.
 * Runs are idempotent and safe to repeat. One instance at a time runs each task (PostgreSQL
 * advisory lock); other instances skip it. Accounts, messages, devices and encryption keys are
 * never touched here. Other data has its own cleanup next to the code that owns it: push
 * deliveries (push worker), call history (call sweep), unsent attachment uploads.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('RETENTION_ENABLED', { infer: true })) return;
    this.timer = setInterval(
      () => {
        this.run().catch((error: unknown) => {
          this.logger.warn(
            { message: error instanceof Error ? error.message : 'unknown' },
            'Retention run failed',
          );
        });
      },
      this.config.get('RETENTION_INTERVAL_MS', { infer: true }),
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One cleanup pass. Returns how many rows each task removed. */
  async run(now = new Date()): Promise<RetentionReport> {
    const report: RetentionReport = {
      sessions: 0,
      verificationTokens: 0,
      resetTokens: 0,
      auditEvents: 0,
    };
    if (this.running) return report;
    this.running = true;
    try {
      for (const [index, task] of TASKS.entries()) {
        report[task] = await this.locked(index, (tx) => this.purge(tx, task, now));
      }
      const total = Object.values(report).reduce((sum, n) => sum + n, 0);
      if (total > 0) {
        // Counts only: what was removed is, by definition, no longer there to describe.
        await this.audit.record({ type: 'RETENTION_PURGED', details: { ...report } });
        this.logger.log({ ...report }, 'Retention cleanup removed expired records');
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Runs `work` in a transaction holding this task's advisory lock, or skips it (0). */
  private locked(
    index: number,
    work: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${index}::int) AS locked`;
        if (!row?.locked) return 0;
        return work(tx);
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private async purge(
    tx: Prisma.TransactionClient,
    task: RetentionTask,
    now: Date,
  ): Promise<number> {
    const batch = this.config.get('RETENTION_BATCH_SIZE', { infer: true });
    const maxBatches = this.config.get('RETENTION_MAX_BATCHES', { infer: true });
    const days = (
      name: 'RETENTION_SESSION_DAYS' | 'RETENTION_TOKEN_DAYS' | 'AUDIT_RETENTION_DAYS',
    ) => new Date(now.getTime() - this.config.get(name, { infer: true }) * DAY_MS);

    let deleteBatch: () => Promise<number>;
    switch (task) {
      case 'sessions': {
        // Ended = revoked, or past its absolute expiry. Active sessions never match: the
        // cutoff is at least 7 days in the past (env validation).
        const cutoff = days('RETENTION_SESSION_DAYS');
        deleteBatch = () => tx.$executeRaw`
          DELETE FROM "sessions" WHERE "id" IN (
            SELECT s."id" FROM "sessions" s
            WHERE ((s."revoked_at" IS NOT NULL AND s."revoked_at" < ${cutoff})
                OR (s."revoked_at" IS NULL AND s."expires_at" < ${cutoff}))
              AND NOT EXISTS (SELECT 1 FROM "retention_holds" h WHERE h."user_id" = s."user_id")
            LIMIT ${batch})`;
        break;
      }
      case 'verificationTokens': {
        const cutoff = days('RETENTION_TOKEN_DAYS');
        deleteBatch = () => tx.$executeRaw`
          DELETE FROM "email_verification_tokens" WHERE "id" IN (
            SELECT "id" FROM "email_verification_tokens"
            WHERE "consumed_at" < ${cutoff} OR "expires_at" < ${cutoff}
            LIMIT ${batch})`;
        break;
      }
      case 'resetTokens': {
        const cutoff = days('RETENTION_TOKEN_DAYS');
        deleteBatch = () => tx.$executeRaw`
          DELETE FROM "password_reset_tokens" WHERE "id" IN (
            SELECT "id" FROM "password_reset_tokens"
            WHERE "consumed_at" < ${cutoff} OR "expires_at" < ${cutoff}
            LIMIT ${batch})`;
        break;
      }
      case 'auditEvents': {
        // The append-only trigger allows this transaction (and only this one) to delete, and
        // never anything younger than 365 days, whatever AUDIT_RETENTION_DAYS says.
        await tx.$executeRaw`SELECT set_config('ogc.audit_retention', 'on', true)`;
        const cutoff = days('AUDIT_RETENTION_DAYS');
        deleteBatch = () => tx.$executeRaw`
          DELETE FROM "audit_events" WHERE "id" IN (
            SELECT a."id" FROM "audit_events" a
            WHERE a."created_at" < ${cutoff}
              AND (a."user_id" IS NULL OR NOT EXISTS (
                SELECT 1 FROM "retention_holds" h WHERE h."user_id" = a."user_id"))
            LIMIT ${batch})`;
        break;
      }
    }

    let removed = 0;
    for (let i = 0; i < maxBatches; i++) {
      const count = await deleteBatch();
      removed += count;
      if (count < batch) break;
    }
    return removed;
  }
}
