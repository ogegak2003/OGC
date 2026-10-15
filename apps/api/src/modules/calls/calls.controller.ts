import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CallPage } from '@ogc/types';
import { type CallHistoryQuery, callHistoryQuerySchema } from '@ogc/validation';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { CallsService } from './calls.service.js';

/**
 * `/api/v1/calls` — the caller's own call history (metadata only), newest first; optionally
 * one conversation's calls, which requires being a participant (404 otherwise). Signaling
 * itself runs over the realtime connection.
 */
@Controller('calls')
@Throttle({ default: throttle('sync') })
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(callHistoryQuerySchema)) query: CallHistoryQuery,
  ): Promise<CallPage> {
    return this.calls.history(auth.userId, query);
  }
}
