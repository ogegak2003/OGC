import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PushProviderName } from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { CommunityNotificationsService } from './community-notifications.service.js';
import { type PushNotification, PushProvider } from './push-provider.js';

/**
 * Push tokens and new-message notifications. A token is bound to the
 * authenticated device that registers it (never to a client-supplied user or
 * device), is moved if another device registers the same token, and is
 * deleted on logout. Devices with a live realtime connection are skipped.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PushProvider,
    private readonly presence: PresenceStore,
    private readonly events: DomainEventBus,
    private readonly community: CommunityNotificationsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type !== 'message.created' || event.recipientIds.length === 0) return;
      this.notifyNewMessage(event.conversationId, event.recipientIds, event.mentionedIds).catch(
        (error: unknown) => {
          this.logger.warn({ err: error }, 'Push notification failed');
        },
      );
      if (event.mentionedIds.length > 0) {
        this.notifyMentions(event.conversationId, event.messageId, event.mentionedIds).catch(
          (error: unknown) => {
            this.logger.warn({ err: error }, 'Mention notification failed');
          },
        );
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async register(auth: AuthContext, provider: PushProviderName, token: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.pushToken.deleteMany({
        where: { provider, token, deviceId: { not: auth.deviceId } },
      }),
      this.prisma.pushToken.upsert({
        where: { deviceId: auth.deviceId },
        create: { deviceId: auth.deviceId, provider, token },
        update: { provider, token },
      }),
    ]);
  }

  async unregister(auth: AuthContext): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { deviceId: auth.deviceId } });
  }

  /**
   * Generic "New message" push to recipients' offline devices, honouring each
   * member's notification level and mute (groups: `MENTIONS` only pushes when
   * the sender declared a mention of them).
   */
  async notifyNewMessage(
    conversationId: string,
    recipientIds: string[],
    mentionedIds: string[] = [],
  ): Promise<number> {
    const now = new Date();
    const mentioned = new Set(mentionedIds);
    const preferences = await this.prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { in: recipientIds } },
      select: { userId: true, notificationLevel: true, mutedUntil: true },
    });
    const wanted = preferences
      .filter(
        (p) =>
          !(p.mutedUntil && p.mutedUntil > now) &&
          (p.notificationLevel === 'ALL' ||
            (p.notificationLevel === 'MENTIONS' && mentioned.has(p.userId))),
      )
      .map((p) => p.userId);
    if (wanted.length === 0) return 0;
    const tokens = await this.prisma.pushToken.findMany({
      where: {
        device: {
          userId: { in: wanted },
          sessions: { some: { revokedAt: null, expiresAt: { gt: now } } },
        },
      },
      select: { deviceId: true, provider: true, token: true },
    });
    if (tokens.length === 0) return 0;
    const online = await this.presence.onlineDevices(tokens.map((t) => t.deviceId));
    const notifications: PushNotification[] = tokens
      .filter((t) => !online.has(t.deviceId))
      .map((t) => ({
        provider: t.provider,
        token: t.token,
        title: 'OGC',
        body: 'New message',
        data: { type: 'message', conversationId },
      }));
    await this.provider.send(notifications);
    return notifications.length;
  }

  /** In-app mention notifications (once per message and person), unless they turned them off. */
  private async notifyMentions(
    conversationId: string,
    messageId: string,
    mentionedIds: string[],
  ): Promise<void> {
    const [group, preferences] = await Promise.all([
      this.prisma.groupProfile.findUnique({
        where: { conversationId },
        select: { name: true },
      }),
      this.prisma.conversationParticipant.findMany({
        where: { conversationId, userId: { in: mentionedIds }, notificationLevel: { not: 'NONE' } },
        select: { userId: true },
      }),
    ]);
    if (!group) return;
    await this.community.notify(
      preferences.map((p) => ({
        userId: p.userId,
        type: 'MENTION' as const,
        dedupeKey: `mention:${messageId}`,
        data: { conversationId, messageId, groupName: group.name },
      })),
    );
  }
}
