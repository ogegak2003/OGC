import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AccountStatus } from '@ogc/types';
import { accountStatusChangeSchema, ogcIdSchema } from '@ogc/validation';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import { AccountStatusService } from './account-status.service.js';
import type { AuthContext } from './auth-context.js';
import { AUTH_RATE_LIMITS } from './auth.constants.js';
import { CurrentAuth } from './decorators.js';
import { RequireStaffRole } from './staff-roles.js';

/** Administrators only: suspend or reinstate an account (audited with actor and reason). */
@Controller('admin/accounts')
@RequireStaffRole('ADMIN')
export class AdminAccountsController {
  constructor(private readonly accounts: AccountStatusService) {}

  @Throttle({ default: AUTH_RATE_LIMITS.sessions })
  @Post(':ogcId/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: string,
    @Body(new ZodValidationPipe(accountStatusChangeSchema)) body: { reason: string },
    @Req() req: Request,
  ): Promise<{ status: AccountStatus; sessionsEnded: number }> {
    return this.accounts.suspend(auth, ogcId, body.reason, requestMeta(req));
  }

  @Throttle({ default: AUTH_RATE_LIMITS.sessions })
  @Post(':ogcId/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: string,
    @Body(new ZodValidationPipe(accountStatusChangeSchema)) body: { reason: string },
    @Req() req: Request,
  ): Promise<{ status: AccountStatus }> {
    return this.accounts.reinstate(auth, ogcId, body.reason, requestMeta(req));
  }
}
