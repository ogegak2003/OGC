import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PushData } from '@ogc/types';
import { MetricsService } from '../../common/metrics/metrics.js';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PresenceStore } from '../realtime/presence.store.js';
import {
  type PushCategory,
  backoffMs,
  categoryAllowed,
  settingsFrom,
  titleFor,
  tone,
} from './push-policy.js';
import {
  type PushBody,
  type PushNotification,
  PushProvider,
  type PushResult,
} from './push-provider.js';

/** One push to queue, for one or more recipients. */
export interface PushRequest {
  userIds: string[];
  category: PushCategory;
  /** Identifies the event (e.g. `message:<id>`): queuing it twice never notifies twice. */
  dedupeKey: string;
  body: PushBody;
  data: PushData;
  /** Shown as the title only to recipients who chose sender previews. */
  senderName?: string | undefined;
  /** Calls: high priority. */
  urgent?: boolean;
  /** How long the push is worth delivering. */
  ttlSeconds: number;
}

interface ClaimedRow {
  id: string;
  deviceId: string;
  category: PushCategory;
  title: string;
  body: string;
  data: PushData;
  sound: boolean;
  vibration: boolean;
  urgent: boolean;
  attempts: number;
  expiresAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const RECEIPT_CHECK_MS = 30_000;
const BACKLOG_CHECK_MS = 15_000;
/** A worker owns claimed rows this long; a crashed worker's rows are reclaimed afterwards. */
const LOCK_SECONDS = 60;

/**
 * The durable push queue (ADR-038). Events are turned into one row per recipient device —
 * after account status, preferences and live connections are checked — and a worker on
 * every API instance sends them: rows are claimed with FOR UPDATE SKIP LOCKED, temporary
 * provider errors are retried with backoff up to a limit, dead tokens are removed, stale
 * pushes expire, receipts are checked, and old rows are deleted. Nothing here ever holds
 * message content; a push is only an alert, the message itself stays in the encrypted
 * messaging flow.
 */
@Injectable()
export class PushDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDeliveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  private lastReceipts = 0;
  private lastBacklog = 0;
  private lastRetention = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PushProvider,
    private readonly presence: PresenceStore,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => {
        void this.process();
      },
      this.config.get('PUSH_WORKER_INTERVAL_MS', { infer: true }),
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Whether pushes are configured at all (`PUSH_PROVIDER=disabled` queues nothing). */
  get enabled(): boolean {
    return this.provider.name !== 'disabled';
  }

  /**
   * Queues a push for each recipient's devices that should get it: active account, the
   * category wanted, a push token, a live session, and no live realtime connection (an open
   * app shows the event itself). Returns how many were queued. Never throws.
   */
  async enqueue(request: PushRequest, now = new Date()): Promise<number> {
    if (!this.enabled || request.userIds.length === 0) return 0;
    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: [...new Set(request.userIds)] }, status: 'ACTIVE' },
        select: { id: true, notificationSettings: true },
      });
      const settings = new Map(
        users
          .map((u) => [u.id, settingsFrom(u.notificationSettings)] as const)
          .filter(([, s]) => categoryAllowed(s, request.category)),
      );
      if (settings.size === 0) return 0;
      const tokens = await this.prisma.pushToken.findMany({
        where: {
          device: {
            userId: { in: [...settings.keys()] },
            sessions: { some: { revokedAt: null, expiresAt: { gt: now } } },
          },
        },
        select: { deviceId: true, device: { select: { userId: true } } },
      });
      if (tokens.length === 0) return 0;
      const online = await this.presence.onlineDevices(tokens.map((t) => t.deviceId));
      const expiresAt = new Date(now.getTime() + request.ttlSeconds * 1000);
      const rows = tokens.flatMap((t) => {
        const prefs = settings.get(t.device.userId);
        if (!prefs || online.has(t.deviceId)) return [];
        const { sound, vibration } = tone(prefs, now);
        return [
          {
            userId: t.device.userId,
            deviceId: t.deviceId,
            category: request.category,
            dedupeKey: request.dedupeKey,
            title: titleFor(prefs, request.senderName),
            body: request.body,
            data: request.data,
            sound,
            vibration,
            urgent: request.urgent ?? false,
            expiresAt,
          },
        ];
      });
      if (rows.length === 0) return 0;
      const { count } = await this.prisma.pushDelivery.createMany({
        data: rows,
        skipDuplicates: true,
      });
      this.metrics.pushDeliveries.inc({ category: request.category, outcome: 'queued' }, count);
      if (count > 0) this.kick();
      return count;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'Push enqueue failed',
      );
      return 0;
    }
  }

  /** Runs a pass soon (new work), without overlapping a running one. */
  private kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    setImmediate(() => {
      void this.process();
    });
  }

  /** One worker pass: send due pushes, then (periodically) receipts, metrics and retention. */
  async process(now = Date.now()): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const claimed = await this.claim();
        if (claimed.length > 0) await this.deliver(claimed, now);
        if (claimed.length >= this.config.get('PUSH_BATCH_SIZE', { infer: true }))
          this.again = true;
      } while (this.again);
      if (now - this.lastReceipts >= RECEIPT_CHECK_MS) {
        this.lastReceipts = now;
        await this.checkReceipts(now);
      }
      if (now - this.lastBacklog >= BACKLOG_CHECK_MS) {
        this.lastBacklog = now;
        await this.measureBacklog(now);
      }
      if (now - this.lastRetention >= HOUR_MS) {
        this.lastRetention = now;
        const days = this.config.get('PUSH_DELIVERY_RETENTION_DAYS', { infer: true });
        await this.prisma.pushDelivery.deleteMany({
          where: { createdAt: { lt: new Date(now - days * 24 * HOUR_MS) } },
        });
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Push worker pass failed',
      );
    } finally {
      this.running = false;
    }
  }

  /** Claims due rows (and rows a crashed worker left behind) for this instance. */
  private claim(): Promise<ClaimedRow[]> {
    const batch = this.config.get('PUSH_BATCH_SIZE', { infer: true });
    return this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE push_deliveries
         SET status = 'SENDING'::"PushDeliveryStatus",
             locked_until = now() + make_interval(secs => ${LOCK_SECONDS}),
             attempts = attempts + 1,
             updated_at = now()
       WHERE id IN (
         SELECT id FROM push_deliveries
          WHERE (status = 'PENDING'::"PushDeliveryStatus" AND next_attempt_at <= now())
             OR (status = 'SENDING'::"PushDeliveryStatus" AND locked_until < now())
          ORDER BY next_attempt_at
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, device_id AS "deviceId", category, title, body, data, sound, vibration,
                urgent, attempts, expires_at AS "expiresAt"`;
  }

  private async deliver(rows: ClaimedRow[], now: number): Promise<void> {
    const live = rows.filter((row) => row.expiresAt.getTime() > now);
    const expired = rows.filter((row) => row.expiresAt.getTime() <= now);
    if (expired.length > 0) {
      await this.prisma.pushDelivery.updateMany({
        where: { id: { in: expired.map((r) => r.id) } },
        data: { status: 'EXPIRED', lockedUntil: null, lastError: 'Expired' },
      });
      for (const row of expired)
        this.metrics.pushDeliveries.inc({ category: row.category, outcome: 'expired' });
    }
    if (live.length === 0) return;

    // The device's token now (it may have changed or been removed since queuing).
    const tokens = new Map(
      (
        await this.prisma.pushToken.findMany({
          where: { deviceId: { in: [...new Set(live.map((r) => r.deviceId))] } },
          select: { deviceId: true, provider: true, token: true },
        })
      ).map((t) => [t.deviceId, t]),
    );
    const sendable = live.filter((row) => tokens.has(row.deviceId));
    const tokenless = live.filter((row) => !tokens.has(row.deviceId));
    if (tokenless.length > 0) {
      await this.prisma.pushDelivery.updateMany({
        where: { id: { in: tokenless.map((r) => r.id) } },
        data: { status: 'FAILED', lockedUntil: null, lastError: 'NoToken' },
      });
      for (const row of tokenless)
        this.metrics.pushDeliveries.inc({ category: row.category, outcome: 'failed' });
    }
    if (sendable.length === 0) return;

    const notifications: PushNotification[] = sendable.map((row) => {
      const token = tokens.get(row.deviceId);
      return {
        provider: token?.provider ?? 'EXPO',
        token: token?.token ?? '',
        title: row.title,
        body: row.body as PushBody,
        data: row.data,
        sound: row.sound,
        vibration: row.vibration,
        urgent: row.urgent,
        ttlSeconds: Math.max(1, Math.round((row.expiresAt.getTime() - now) / 1000)),
      };
    });
    let results: PushResult[];
    try {
      results = (await this.provider.send(notifications)) ?? sendable.map(() => ({ ok: true }));
    } catch {
      results = sendable.map(() => ({
        ok: false,
        code: 'PROVIDER_EXCEPTION',
        retryable: true,
        invalidToken: false,
      }));
    }

    const maxAttempts = this.config.get('PUSH_MAX_ATTEMPTS', { infer: true });
    const baseMs = this.config.get('PUSH_RETRY_BASE_MS', { infer: true });
    await Promise.all(
      sendable.map(async (row, index) => {
        const result = results[index] ?? {
          ok: false,
          code: 'NoResult',
          retryable: true,
          invalidToken: false,
        };
        if (result.ok) {
          this.metrics.pushDeliveries.inc({ category: row.category, outcome: 'sent' });
          await this.prisma.pushDelivery.update({
            where: { id: row.id },
            data: {
              status: 'SENT',
              sentAt: new Date(now),
              lockedUntil: null,
              lastError: null,
              ticketId: result.ticketId ?? null,
            },
          });
          return;
        }
        this.metrics.pushErrors.inc({ code: result.code });
        if (result.invalidToken) {
          // The app was uninstalled or the token rotated: stop using it.
          const token = tokens.get(row.deviceId);
          if (token) {
            await this.prisma.pushToken.deleteMany({
              where: { deviceId: row.deviceId, token: token.token },
            });
          }
        }
        const retry = result.retryable && !result.invalidToken && row.attempts < maxAttempts;
        this.metrics.pushDeliveries.inc({
          category: row.category,
          outcome: retry ? 'retried' : 'failed',
        });
        await this.prisma.pushDelivery.update({
          where: { id: row.id },
          data: retry
            ? {
                status: 'PENDING',
                lockedUntil: null,
                lastError: result.code.slice(0, 64),
                nextAttemptAt: new Date(now + backoffMs(row.attempts, baseMs)),
              }
            : { status: 'FAILED', lockedUntil: null, lastError: result.code.slice(0, 64) },
        });
      }),
    );
  }

  /** Expo receipts: confirms delivery to Apple/Google, and finds tokens that died since. */
  private async checkReceipts(now: number): Promise<void> {
    const delay = this.config.get('PUSH_RECEIPT_DELAY_SECONDS', { infer: true }) * 1000;
    const sent = await this.prisma.pushDelivery.findMany({
      where: { status: 'SENT', ticketId: { not: null }, sentAt: { lte: new Date(now - delay) } },
      select: { id: true, deviceId: true, ticketId: true, category: true },
      orderBy: { sentAt: 'asc' },
      take: 1000,
    });
    if (sent.length === 0) return;
    const receipts = await this.provider.receipts(
      sent.flatMap((r) => (r.ticketId ? [r.ticketId] : [])),
    );
    for (const row of sent) {
      const receipt = row.ticketId ? receipts.get(row.ticketId) : undefined;
      if (!receipt) continue;
      if (receipt.ok) {
        this.metrics.pushDeliveries.inc({ category: row.category, outcome: 'delivered' });
        await this.prisma.pushDelivery.update({
          where: { id: row.id },
          data: { status: 'DELIVERED' },
        });
        continue;
      }
      this.metrics.pushErrors.inc({ code: receipt.code });
      this.metrics.pushDeliveries.inc({ category: row.category, outcome: 'failed' });
      if (receipt.invalidToken)
        await this.prisma.pushToken.deleteMany({ where: { deviceId: row.deviceId } });
      await this.prisma.pushDelivery.update({
        where: { id: row.id },
        data: { status: 'FAILED', lastError: receipt.code.slice(0, 64) },
      });
    }
  }

  private async measureBacklog(now: number): Promise<void> {
    const [pending, oldest] = await Promise.all([
      this.prisma.pushDelivery.count({ where: { status: { in: ['PENDING', 'SENDING'] } } }),
      this.prisma.pushDelivery.findFirst({
        where: { status: { in: ['PENDING', 'SENDING'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    this.metrics.pushBacklog.set(pending);
    this.metrics.pushOldestPendingSeconds.set(
      oldest ? Math.max(0, (now - oldest.createdAt.getTime()) / 1000) : 0,
    );
  }
}
