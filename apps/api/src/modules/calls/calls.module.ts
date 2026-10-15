import { Module } from '@nestjs/common';
import { ConversationAccessModule } from '../conversations/conversation-access.module.js';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';

/** One-to-one voice and video calls: signaling state, timeouts and history (ADR-037). */
@Module({
  imports: [ConversationAccessModule, RelationshipsModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
