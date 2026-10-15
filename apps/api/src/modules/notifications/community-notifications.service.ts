import { Injectable, Logger } from '@nestjs/common';
import type { NotificationPage, NotificationType, NotificationView } from '@ogc/types';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { PushDeliveryService } from './push-delivery.service.js';
import type { PushCategory } from './push-policy.js';
import { COMMUNITY_PUSH_BODY } from './push-provider.js';

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
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Which notification setting governs each community notification type. */
const PUSH_CATEGORY: Record<NotificationType, PushCategory> = {
  GROUP_INVITATION: 'GROUP',
  GROUP_MEMBER_ADDED: 'GROUP',
  GROUP_MEMBER_REMOVED: 'GROUP',
  GROUP_ROLE_CHANGED: 'GROUP',
  GROUP_DETAILS_CHANGED: 'GROUP',
  MENTION: 'GROUP',
  CHANNEL_ANNOUNCEMENT: 'CHANNEL',
  CHANNEL_ROLE_CHANGED: 'CHANNEL',
  CHANNEL_JOIN_REQUEST: 'CHANNEL',
  CHANNEL_REQUEST_APPROVED: 'CHANNEL',
  CHANNEL_MEMBER_REMOVED: 'CHANNEL',
  MODERATION_RESULT: 'ACCOUNT',
  INVITATION_EXPIRED: 'ACCOUNT',
};

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
    private readonly pushes: PushDeliveryService,
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
    const keys = new Map(inputs.map((n) => [`${n.userId}|${n.type}`, n.dedupeKey]));
    await this.push(
      created.map((row) => ({
        userId: row.userId,
        type: row.type,
        dedupeKey: keys.get(`${row.userId}|${row.type}`) ?? row.id,
      })),
    );
  }

  /**
   * Generic push for each new notification, through the delivery queue (which applies each
   * recipient's settings and skips devices with a live connection). One queue request per
   * notification type and event, so a 10 000-member announcement is a handful of requests.
   */
  private async push(
    items: { userId: string; type: NotificationType; dedupeKey: string }[],
  ): Promise<void> {
    const groups = new Map<
      string,
      { type: NotificationType; dedupeKey: string; userIds: string[] }
    >();
    for (const item of items) {
      const key = `${item.type}|${item.dedupeKey}`;
      const group = groups.get(key) ?? { type: item.type, dedupeKey: item.dedupeKey, userIds: [] };
      group.userIds.push(item.userId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await this.pushes.enqueue({
        userIds: group.userIds,
        category: PUSH_CATEGORY[group.type],
        dedupeKey: `community:${group.type}:${group.dedupeKey}`,
        body: COMMUNITY_PUSH_BODY[group.type],
        data: { type: 'community', notification: group.type },
        ttlSeconds: WEEK_SECONDS,
      });
    }
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
