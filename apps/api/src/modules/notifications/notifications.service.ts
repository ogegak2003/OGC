import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PushProviderName } from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PresenceStore } from '../realtime/presence.store.js';
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
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type !== 'message.created' || event.recipientIds.length === 0) return;
      this.notifyNewMessage(event.conversationId, event.recipientIds).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Push notification failed');
      });
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

  async notifyNewMessage(conversationId: string, recipientIds: string[]): Promise<number> {
    const now = new Date();
    const tokens = await this.prisma.pushToken.findMany({
      where: {
        device: {
          userId: { in: recipientIds },
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
}
