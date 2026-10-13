import { Module } from '@nestjs/common';
import { ConversationAccessModule } from '../conversations/conversation-access.module.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

@Module({
  imports: [ConversationAccessModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
