import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  BridgeCallView,
  BridgeEligibilityView,
  BridgeNumberView,
  BridgeStatusView,
  BridgeUsageView,
  BridgeVerificationView,
  OgcId,
} from '@ogc/types';
import {
  type BridgeConfirmVerification,
  type BridgeStartCall,
  type BridgeStartVerification,
  bridgeConfirmVerificationSchema,
  bridgeEligibilityQuerySchema,
  bridgePreferencesSchema,
  bridgeStartCallSchema,
  bridgeStartVerificationSchema,
  uuidSchema,
} from '@ogc/validation';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { RequireStaffRole } from '../auth/staff-roles.js';
import { BRIDGE_RATE_LIMITS } from './bridge.config.js';
import { BridgeBillingService } from './bridge-billing.service.js';
import { BridgeCallsService } from './bridge-calls.service.js';
import { BridgeNumbersService } from './bridge-numbers.service.js';

const idParam = new ZodValidationPipe(uuidSchema);

/** OGC Bridge for the signed-in person: their number, eligibility, calls and usage. */
@Controller('bridge')
export class BridgeController {
  constructor(
    private readonly numbers: BridgeNumbersService,
    private readonly calls: BridgeCallsService,
    private readonly billing: BridgeBillingService,
  ) {}

  /** Always available, so clients can show "not available" or "not configured" truthfully. */
  @Get()
  @Throttle({ default: BRIDGE_RATE_LIMITS.read })
  status(@CurrentAuth() auth: AuthContext): Promise<BridgeStatusView> {
    return this.numbers.status(auth.userId);
  }

  @Post('number/verification')
  @Throttle({ default: BRIDGE_RATE_LIMITS.startVerification })
  startVerification(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(bridgeStartVerificationSchema)) body: BridgeStartVerification,
    @Req() req: Request,
  ): Promise<BridgeVerificationView> {
    return this.numbers.startVerification(auth.userId, body, requestMeta(req));
  }

  @Post('number/verify')
  @Throttle({ default: BRIDGE_RATE_LIMITS.confirmVerification })
  confirmVerification(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(bridgeConfirmVerificationSchema)) body: BridgeConfirmVerification,
    @Req() req: Request,
  ): Promise<BridgeNumberView> {
    return this.numbers.confirmVerification(auth.userId, body, requestMeta(req));
  }

  @Patch('number')
  @Throttle({ default: BRIDGE_RATE_LIMITS.update })
  setPreferences(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(bridgePreferencesSchema)) body: { allowContactCalls: boolean },
  ): Promise<BridgeNumberView> {
    return this.numbers.setPreferences(auth.userId, body.allowContactCalls);
  }

  @Delete('number')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: BRIDGE_RATE_LIMITS.update })
  unlink(@CurrentAuth() auth: AuthContext, @Req() req: Request): Promise<void> {
    return this.numbers.unlink(auth.userId, requestMeta(req));
  }

  @Get('eligibility')
  @Throttle({ default: BRIDGE_RATE_LIMITS.eligibility })
  eligibility(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(bridgeEligibilityQuerySchema)) query: { ogcId: OgcId },
  ): Promise<BridgeEligibilityView> {
    return this.calls.eligibility(auth.userId, query.ogcId, new Date());
  }

  @Post('calls')
  @Throttle({ default: BRIDGE_RATE_LIMITS.startCall })
  startCall(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(bridgeStartCallSchema)) body: BridgeStartCall,
    @Req() req: Request,
  ): Promise<BridgeCallView> {
    return this.calls.start(auth.userId, body.ogcId, body.idempotencyKey, requestMeta(req));
  }

  @Get('calls')
  @Throttle({ default: BRIDGE_RATE_LIMITS.read })
  listCalls(@CurrentAuth() auth: AuthContext): Promise<BridgeCallView[]> {
    return this.calls.list(auth.userId);
  }

  @Get('calls/:id')
  @Throttle({ default: BRIDGE_RATE_LIMITS.read })
  getCall(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<BridgeCallView> {
    return this.calls.get(auth.userId, id);
  }

  @Post('calls/:id/end')
  @Throttle({ default: BRIDGE_RATE_LIMITS.endCall })
  endCall(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<BridgeCallView> {
    return this.calls.cancel(auth.userId, id);
  }

  @Get('usage')
  @Throttle({ default: BRIDGE_RATE_LIMITS.read })
  usage(@CurrentAuth() auth: AuthContext): Promise<BridgeUsageView> {
    return this.billing.usage(auth.userId, new Date());
  }
}

const adjustmentSchema = z.strictObject({
  userId: uuidSchema,
  callId: uuidSchema.nullable(),
  kind: z.enum(['REFUND', 'ADJUSTMENT']),
  amountMinor: z.number().int().min(-100_000_000).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reference: z.string().min(8).max(100),
  note: z.string().trim().min(3).max(200),
});

/** Staff-only, audited corrections and reconciliation. */
@Controller('admin/bridge')
@RequireStaffRole('ADMIN')
export class BridgeAdminController {
  constructor(private readonly billing: BridgeBillingService) {}

  @Post('adjustments')
  @HttpCode(HttpStatus.NO_CONTENT)
  adjust(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(adjustmentSchema)) body: z.infer<typeof adjustmentSchema>,
  ): Promise<void> {
    return this.billing.adjust({ ...body, staffUserId: auth.userId });
  }

  @Get('reconciliation')
  reconcile(): Promise<{ callId: string; problem: string }[]> {
    return this.billing.reconcile(new Date(Date.now() - 7 * 86_400_000));
  }
}
