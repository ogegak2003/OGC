import { Module } from '@nestjs/common';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsService } from './contacts.service.js';

@Module({
  imports: [RelationshipsModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
