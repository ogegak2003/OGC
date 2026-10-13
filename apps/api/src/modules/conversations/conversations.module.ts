import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { E2eeModule } from '../e2ee/e2ee.module.js';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import { ConversationAccessModule } from './conversation-access.module.js';
import { ConversationsController, MessagesController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';
import { MessagesService } from './messages.service.js';
import { MlsService } from './mls.service.js';

@Module({
  imports: [AuditModule, E2eeModule, RelationshipsModule, ConversationAccessModule],
  controllers: [ConversationsController, MessagesController],
  providers: [ConversationsService, MessagesService, MlsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
