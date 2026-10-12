import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffRolesGuard } from '../auth/staff-roles.js';
import { AdminReportsController, ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [AuditModule],
  controllers: [ReportsController, AdminReportsController],
  providers: [ReportsService, StaffRolesGuard],
})
export class ReportsModule {}
