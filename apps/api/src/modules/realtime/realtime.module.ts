import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CallsModule } from '../calls/calls.module.js';
import { ConversationAccessModule } from '../conversations/conversation-access.module.js';
import { PresenceStore } from './presence.store.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimePublisher } from './realtime.publisher.js';

/** Publisher and presence are global so any domain module can emit realtime events. */
@Global()
@Module({
  providers: [RealtimePublisher, PresenceStore],
  exports: [RealtimePublisher, PresenceStore],
})
export class RealtimeCoreModule {}

@Module({
  imports: [AuthModule, ConversationAccessModule, CallsModule],
  providers: [RealtimeGateway],
})
export class RealtimeGatewayModule {}
