import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Domain events raised after a change commits. Today nothing but tests and
 * logs listen; they are the seam for future realtime updates and push
 * notifications (see docs/architecture/social-graph.md#events). Payloads carry
 * internal IDs only and must never include secrets or private content.
 */
export type DomainEvent =
  | { type: 'contact.request.sent'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.request.accepted'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.request.declined'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.request.cancelled'; requestId: string; senderId: string; recipientId: string }
  | { type: 'contact.removed'; userId: string; contactUserId: string }
  | { type: 'user.blocked'; blockerId: string; blockedId: string }
  | { type: 'user.unblocked'; blockerId: string; blockedId: string }
  | { type: 'profile.updated'; userId: string; fields: string[] };

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
