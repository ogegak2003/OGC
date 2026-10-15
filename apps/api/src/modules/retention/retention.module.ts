import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RetentionService } from './retention.service.js';

@Module({
  imports: [AuditModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
