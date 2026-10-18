import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryLaterException } from '../../common/errors.js';
import type { Env } from '../../config/env.schema.js';
import type { Prisma } from '../../generated/prisma/client.js';

/** Namespace (first key) of the transaction-scoped advisory locks taken per device. */
const RESYNC_LOCK_NAMESPACE = 0x6f67_6301; // "ogc" + 1

export interface ResyncLimits {
  perConversation: number;
  conversationWindowMs: number;
  perDevice: number;
  deviceWindowMs: number;
}

/**
 * Seconds until a window holding `times` (accepted resyncs, oldest first) admits one more
 * under `limit`, or 0 if it already does. The count only falls as resyncs age out, so this is
 * exactly when the (n − limit + 1)-th oldest leaves the window.
 */
export function secondsUntilAllowed(
  times: readonly Date[],
  limit: number,
  windowMs: number,
  now: Date,
): number {
  if (times.length < limit) return 0;
  const freeing = times[times.length - limit];
  if (!freeing) return 0;
  return Math.max(1, Math.ceil((freeing.getTime() + windowMs - now.getTime()) / 1000));
}

/**
 * Limits how often one device may resync (rejoin in place of its own leaf after losing its
 * group state): per conversation and device-wide, counting only resyncs that were committed.
 *
 * Runs inside the commit transaction, after `nextVersion` has locked the conversation row, so
 * a rejected or rolled-back commit never counts. Lock order is always: conversation row, then
 * this device's advisory lock — and nothing takes a conversation lock while holding a device
 * lock, so the two cannot deadlock. The device lock serializes resyncs of one device across
 * conversations and API instances, which the conversation lock alone cannot.
 */
@Injectable()
export class MlsResyncLimiter {
  readonly limits: ResyncLimits;

  constructor(config: ConfigService<Env, true>) {
    this.limits = {
      perConversation: config.get('RATE_LIMIT_MLS_RESYNC_PER_CONVERSATION', { infer: true }),
      conversationWindowMs:
        config.get('RATE_LIMIT_MLS_RESYNC_WINDOW_MINUTES', { infer: true }) * 60_000,
      perDevice: config.get('RATE_LIMIT_MLS_RESYNC_PER_DEVICE', { infer: true }),
      deviceWindowMs: config.get('RATE_LIMIT_MLS_RESYNC_DEVICE_HOURS', { infer: true }) * 3_600_000,
    };
  }

  /**
   * Throws `MLS_RESYNC_RATE_LIMITED` (429, with the seconds until both limits admit the resync)
   * if this resync would exceed a limit; otherwise returns the database time to record it at.
   */
  async admit(
    tx: Prisma.TransactionClient,
    conversationId: string,
    deviceKeyId: string,
  ): Promise<Date> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RESYNC_LOCK_NAMESPACE}::int, hashtext(${deviceKeyId}))`;
    const { perConversation, conversationWindowMs, perDevice, deviceWindowMs } = this.limits;
    const lookbackMs = Math.max(conversationWindowMs, deviceWindowMs);
    // Current database time throughout (not the transaction start): one clock for all instances.
    const rows = await tx.$queryRaw<{ created_at: Date; same: boolean; now: Date }[]>`
      SELECT created_at, conversation_id = ${conversationId}::uuid AS same, clock_timestamp() AS now
      FROM mls_commits
      WHERE sender_device_key_id = ${deviceKeyId}::uuid
        AND resync
        AND created_at > clock_timestamp() - make_interval(secs => ${lookbackMs / 1000})
      ORDER BY created_at`;
    const now = rows[0]?.now ?? (await this.databaseNow(tx));
    const inWindow = (windowMs: number) =>
      rows.filter((r) => r.created_at.getTime() > now.getTime() - windowMs);
    const conversationTimes = inWindow(conversationWindowMs)
      .filter((r) => r.same)
      .map((r) => r.created_at);
    const deviceTimes = inWindow(deviceWindowMs).map((r) => r.created_at);
    const wait = Math.max(
      secondsUntilAllowed(conversationTimes, perConversation, conversationWindowMs, now),
      secondsUntilAllowed(deviceTimes, perDevice, deviceWindowMs, now),
    );
    if (wait > 0) {
      throw new RetryLaterException(
        'MLS_RESYNC_RATE_LIMITED',
        'This device has rejoined its encrypted conversations too often. Try again later.',
        wait,
      );
    }
    return now;
  }

  private async databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!row) throw new Error('No database time');
    return row.now;
  }
}
