import { Injectable, Logger } from '@nestjs/common';
import type { NotificationPage, NotificationType, NotificationView } from '@ogc/types';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { COMMUNITY_PUSH_BODY, type PushNotification, PushProvider } from './push-provider.js';

/** Values allowed in notification data: IDs, public names and counts — never content. */
export type NotificationData = Record<string, string | number | boolean | null>;

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  /**
   * Idempotency key, unique per recipient (e.g. `invitation:<id>`): retries and
   * duplicate events never notify twice, on any device.
   */
  dedupeKey: string;
  data: NotificationData;
}

/** Recipients are processed in batches so a large channel cannot hold one huge transaction. */
const BATCH_SIZE = 500;
const UNREAD_CAP = 100;

function toView(row: {
  id: string;
  type: NotificationType;
  data: Prisma.JsonValue;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView {
  return {
    id: row.id,
    type: row.type,
    data:
      row.data !== null && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as NotificationData)
        : {},
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * In-app community notifications (invitations, mentions, announcements, role
 * changes, moderation results…). Each is stored once per recipient (dedupe
 * key), delivered in realtime to every connected device, and pushed with a
 * generic text to devices that are offline. Delivery is best-effort and
 * retry-safe; the stored notification is the source of truth.
 */
@Injectable()
export class CommunityNotificationsService {
  private readonly logger = new Logger(CommunityNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisher,
    private readonly presence: PresenceStore,
    private readonly provider: PushProvider,
  ) {}

  /** Stores and delivers notifications. Never throws: failures are logged. */
  async notify(inputs: NotificationInput[]): Promise<void> {
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      try {
        await this.deliverBatch(inputs.slice(i, i + BATCH_SIZE));
      } catch (error) {
        this.logger.warn({ err: error }, 'Community notification delivery failed');
      }
    }
  }

  private async deliverBatch(inputs: NotificationInput[]): Promise<void> {
    if (inputs.length === 0) return;
    // Returns only the rows inserted now: duplicates (same recipient and key) are skipped,
    // so concurrent or retried deliveries never notify twice.
    const created = await this.prisma.notification.createManyAndReturn({
      data: inputs.map((n) => ({
        userId: n.userId,
        type: n.type,
        dedupeKey: n.dedupeKey,
        data: n.data,
      })),
      skipDuplicates: true,
      select: { id: true, userId: true, type: true, data: true, readAt: true, createdAt: true },
    });
    for (const row of created) {
      this.realtime.toUsers([row.userId], 'community.notification', { notification: toView(row) });
    }
    await this.push(created.map((row) => ({ userId: row.userId, type: row.type })));
  }

  private async push(items: { userId: string; type: NotificationType }[]): Promise<void> {
    if (items.length === 0) return;
    const now = new Date();
    const tokens = await this.prisma.pushToken.findMany({
      where: {
        device: {
          userId: { in: [...new Set(items.map((i) => i.userId))] },
          sessions: { some: { revokedAt: null, expiresAt: { gt: now } } },
        },
      },
      select: { deviceId: true, provider: true, token: true, device: { select: { userId: true } } },
    });
    if (tokens.length === 0) return;
    const online = await this.presence.onlineDevices(tokens.map((t) => t.deviceId));
    const typeByUser = new Map(items.map((i) => [i.userId, i.type]));
    const notifications: PushNotification[] = tokens.flatMap((t) => {
      const type = typeByUser.get(t.device.userId);
      if (!type || online.has(t.deviceId)) return [];
      return [
        {
          provider: t.provider,
          token: t.token,
          title: 'OGC',
          body: COMMUNITY_PUSH_BODY[type],
          data: { type: 'community', notification: type },
        },
      ];
    });
    await this.provider.send(notifications);
  }

  async list(userId: string, cursor: string | undefined, limit: number): Promise<NotificationPage> {
    const before = decodeCursor(cursor);
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, ...(before ? { id: { lt: before } } : {}) },
        orderBy: { id: 'desc' },
        take: limit + 1,
        select: { id: true, type: true, data: true, readAt: true, createdAt: true },
      }),
      this.prisma.notification
        .findMany({ where: { userId, readAt: null }, select: { id: true }, take: UNREAD_CAP })
        .then((r) => r.length),
    ]);
    return { ...toPage(rows, limit, toView), unread };
  }

  /** Marks the given notifications (or all) as read. Only the caller's own. */
  async markRead(userId: string, ids: string[] | 'all'): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
  }
}
