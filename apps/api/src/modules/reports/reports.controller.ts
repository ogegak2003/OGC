import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Page, UserReportView } from '@ogc/types';
import { type ReportUserInput, reportUserRequestSchema } from '@ogc/validation';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { RequireStaffRole } from '../auth/staff-roles.js';
import { SOCIAL_RATE_LIMITS } from '../relationships/social.constants.js';
import { type AdminReportQuery, adminReportQuerySchema } from './admin-report-query.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('users')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: SOCIAL_RATE_LIMITS.report })
  async reportUser(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(reportUserRequestSchema)) body: ReportUserInput,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    await this.reports.report(auth.userId, body, requestMeta(req));
    return { received: true };
  }
}

/** Moderation queue foundation. Staff only; no moderation actions yet (later phase). */
@Controller('admin/reports')
@RequireStaffRole('MODERATOR', 'ADMIN')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(adminReportQuerySchema)) query: AdminReportQuery,
  ): Promise<Page<UserReportView>> {
    return this.reports.list(query.status, query);
  }
}
