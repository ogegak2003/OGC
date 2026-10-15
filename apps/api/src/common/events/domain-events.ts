import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Domain events raised after a change commits. Listeners include the realtime
 * gateway (session revocation) and push notifications (new messages); see
 * docs/architecture/social-graph.md#events. Payloads carry internal IDs only
 * and must never include secrets or message content (not even ciphertext).
 */
export type DomainEvent =
  | { type: 'contact.request.sent'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.request.accepted'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.request.declined'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.request.cancelled'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.removed'; userId: string; contactUserId: string }
  | { type: 'user.blocked'; blockerId: string; blockedId: string }
  | { type: 'user.unblocked'; blockerId: string; blockedId: string }
  | { type: 'profile.updated'; userId: string; fields: string[] }
  | { type: 'session.revoked'; sessionId: string; userId: string }
  /** Members joined or left a group/encrypted channel, or a community channel. */
  | { type: 'membership.changed'; conversationId?: string; channelId?: string; userIds: string[] }
  /** A call started ringing on the callee's devices (not raised for hidden or busy calls). */
  | { type: 'call.ringing'; callId: string; conversationId: string; calleeId: string }
  /** Nobody answered before the ring timeout. */
  | { type: 'call.missed'; callId: string; conversationId: string; calleeId: string }
  | {
      type: 'message.created';
      conversationId: string;
      messageId: string;
      senderId: string;
      /** Users who should be notified (excludes recipients who blocked the sender). */
      recipientIds: string[];
      /** Recipients the sender declared as mentioned (groups only; never parsed from content). */
      mentionedIds: string[];
    };

export type DomainEventHandler = (event: DomainEvent) => void;

/** In-process publish/subscribe. Handler failures are logged and never affect the request. */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger('DomainEvents');
  private readonly handlers = new Set<DomainEventHandler>();

  subscribe(handler: DomainEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(event: DomainEvent): void {
    this.logger.debug({ type: event.type }, 'Domain event');
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error({ err: error, type: event.type }, 'Domain event handler failed');
      }
    }
  }
}

@Global()
@Module({ providers: [DomainEventBus], exports: [DomainEventBus] })
export class DomainEventsModule {}
