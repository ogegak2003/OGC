import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import { BlocksController } from './blocks.controller.js';
import { BlocksService } from './blocks.service.js';

@Module({
  imports: [AuditModule, RelationshipsModule],
  controllers: [BlocksController],
  providers: [BlocksService],
})
export class BlocksModule {}
