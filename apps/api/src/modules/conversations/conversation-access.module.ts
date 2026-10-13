import { Module } from '@nestjs/common';
import { ConversationAccessService } from './conversation-access.service.js';

@Module({
  providers: [ConversationAccessService],
  exports: [ConversationAccessService],
})
export class ConversationAccessModule {}
