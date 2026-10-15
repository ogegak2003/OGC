import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NotificationSettingsView, PushProviderName } from '@ogc/types';
import type { NotificationSettingsUpdate } from '@ogc/validation';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CommunityNotificationsService } from './community-notifications.service.js';
import { PushDeliveryService } from './push-delivery.service.js';
import { settingsFrom } from './push-policy.js';

/** Incoming-call pushes are useless once the call stopped ringing. */
const INCOMING_CALL_TTL_SECONDS = 45;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Push tokens, account notification settings, and the pushes for messages, calls and contact
 * requests (community events go through CommunityNotificationsService). A token is bound to
 * the authenticated device that registers it (never to a client-supplied user or device), is
 * moved if another device registers the same token, and is deleted when the session ends.
 * Pushes are queued (PushDeliveryService): generic text, IDs for routing, never content.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushDeliveryService,
    private readonly events: DomainEventBus,
    private readonly community: CommunityNotificationsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((event) => {
      const run = (task: Promise<unknown>, what: string) => {
        task.catch((error: unknown) => {
          this.logger.warn({ err: error }, `${what} failed`);
        });
      };
      switch (event.type) {
        case 'call.ringing':
        case 'call.missed':
          run(
            this.notifyCall(
              event.conversationId,
              event.calleeId,
              event.callId,
              event.type === 'call.ringing' ? 'Incoming call' : 'Missed call',
            ),
            'Call push',
          );
          return;
        case 'contact.request.sent':
          run(
            this.notifyContact(event.recipientId, event.senderId, event.requestId, 'request'),
            'Contact push',
          );
          return;
        case 'contact.request.accepted':
          // The person who sent the request learns it was accepted (by the recipient).
          run(
            this.notifyContact(event.senderId, event.recipientId, event.requestId, 'accepted'),
            'Contact push',
          );
          return;
        case 'message.created':
          if (event.recipientIds.length === 0) return;
          run(
            this.notifyNewMessage(
              event.conversationId,
              event.recipientIds,
              event.mentionedIds,
              event.messageId,
              event.senderId,
            ),
            'Message push',
          );
          if (event.mentionedIds.length > 0) {
            run(
              this.notifyMentions(event.conversationId, event.messageId, event.mentionedIds),
              'Mention notification',
            );
          }
          return;
        default:
          return;
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  // ── Push tokens ─────────────────────────────────────────────────────────────────────────────

  async register(auth: AuthContext, provider: PushProviderName, token: string): Promise<void> {
    await this.prisma.$transaction([
      // A token belongs to one installation: if another device (of any account) had it, the
      // app was reinstalled or signed into a different account there — it moves here.
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

  // ── Settings ────────────────────────────────────────────────────────────────────────────────

  async settings(userId: string): Promise<NotificationSettingsView> {
    return settingsFrom(await this.prisma.notificationSettings.findUnique({ where: { userId } }));
  }

  /** Applies a validated partial update for the signed-in account only. */
  async updateSettings(
    userId: string,
    update: NotificationSettingsUpdate,
  ): Promise<NotificationSettingsView> {
    const { quietHours, ...rest } = update;
    // Only the fields sent (a partial update never resets the others).
    const flags = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    ) as { [K in keyof typeof rest]?: NonNullable<(typeof rest)[K]> };
    const data = {
      ...flags,
      ...(quietHours
        ? {
            quietHoursEnabled: quietHours.enabled,
            quietStart: quietHours.start,
            quietEnd: quietHours.end,
            timeZone: quietHours.timeZone,
          }
        : {}),
    };
    const row = await this.prisma.notificationSettings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return settingsFrom(row);
  }

  // ── Events → pushes ─────────────────────────────────────────────────────────────────────────

  /**
   * "New message" to recipients' offline devices, honouring each member's notification level
   * and mute (groups: `MENTIONS` only pushes when the sender declared a mention of them; a
   * mentioned person gets the mention push instead of a second one). The sender is never a
   * recipient; recipients who blocked the sender were already removed by messaging.
   */
  async notifyNewMessage(
    conversationId: string,
    recipientIds: string[],
    mentionedIds: string[] = [],
    messageId?: string,
    senderId?: string,
  ): Promise<number> {
    const now = new Date();
    const mentioned = new Set(mentionedIds);
    const [preferences, conversation, sender] = await Promise.all([
      this.prisma.conversationParticipant.findMany({
        where: {
          conversationId,
          userId: { in: recipientIds.filter((id) => id !== senderId) },
        },
        select: { userId: true, notificationLevel: true, mutedUntil: true },
      }),
      this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { type: true, groupProfile: { select: { name: true } } },
      }),
      senderId
        ? this.prisma.profile.findUnique({
            where: { userId: senderId },
            select: { displayName: true },
          })
        : null,
    ]);
    if (!conversation) return 0;
    const isGroup = conversation.type !== 'DIRECT';
    const wanted = preferences
      .filter(
        (p) =>
          !(p.mutedUntil && p.mutedUntil > now) &&
          (p.notificationLevel === 'ALL' ||
            (p.notificationLevel === 'MENTIONS' && mentioned.has(p.userId))),
      )
      // In groups, mentioned people get the "You were mentioned" push instead.
      .filter((p) => !(isGroup && mentioned.has(p.userId)))
      .map((p) => p.userId);
    if (wanted.length === 0) return 0;
    const groupName = conversation.groupProfile?.name;
    const senderName = sender?.displayName;
    return this.push.enqueue({
      userIds: wanted,
      category:
        conversation.type === 'DIRECT'
          ? 'MESSAGE'
          : conversation.type === 'CHANNEL'
            ? 'CHANNEL'
            : 'GROUP',
      dedupeKey: `message:${messageId ?? `${conversationId}:${now.toISOString()}`}`,
      body:
        conversation.type === 'DIRECT'
          ? 'New message'
          : conversation.type === 'CHANNEL'
            ? 'New channel message'
            : 'New group message',
      data: { type: 'message', conversationId },
      senderName:
        isGroup && groupName
          ? senderName
            ? `${senderName} · ${groupName}`
            : groupName
          : senderName,
      ttlSeconds: DAY_SECONDS,
    });
  }

  /**
   * "Incoming call" / "Missed call" to the callee's devices without a live connection, unless
   * the conversation is muted or set to no notifications. A push does not ring like a phone
   * call: see docs/architecture/calls.md#incoming-calls-and-push.
   */
  async notifyCall(
    conversationId: string,
    calleeId: string,
    callId: string,
    body: 'Incoming call' | 'Missed call',
  ): Promise<number> {
    const preference = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, userId: calleeId },
      select: {
        notificationLevel: true,
        mutedUntil: true,
        conversation: {
          select: {
            calls: {
              where: { id: callId },
              select: { caller: { select: { profile: { select: { displayName: true } } } } },
            },
          },
        },
      },
    });
    if (
      !preference ||
      preference.notificationLevel === 'NONE' ||
      (preference.mutedUntil && preference.mutedUntil > new Date())
    ) {
      return 0;
    }
    const incoming = body === 'Incoming call';
    return this.push.enqueue({
      userIds: [calleeId],
      category: 'CALL',
      dedupeKey: `call:${callId}:${incoming ? 'incoming' : 'missed'}`,
      body,
      data: { type: 'call', callId, conversationId },
      senderName: preference.conversation.calls[0]?.caller.profile?.displayName,
      urgent: incoming,
      ttlSeconds: incoming ? INCOMING_CALL_TTL_SECONDS : DAY_SECONDS,
    });
  }

  /** Contact request received, or one you sent was accepted. Never to the person who acted. */
  async notifyContact(
    recipientId: string,
    actorId: string,
    requestId: string,
    event: 'request' | 'accepted',
  ): Promise<number> {
    if (recipientId === actorId) return 0;
    const actor = await this.prisma.profile.findUnique({
      where: { userId: actorId },
      select: { displayName: true },
    });
    return this.push.enqueue({
      userIds: [recipientId],
      category: 'CONTACT',
      dedupeKey: `contact:${requestId}:${event}`,
      body: event === 'request' ? 'New contact request' : 'Your contact request was accepted',
      data: { type: 'contact', event },
      senderName: actor?.displayName,
      ttlSeconds: 7 * DAY_SECONDS,
    });
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
