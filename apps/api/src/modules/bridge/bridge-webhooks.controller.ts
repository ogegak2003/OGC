import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiException } from '../../common/errors.js';
import { requestMeta } from '../../common/request-meta.js';
import { AuditService } from '../audit/audit.service.js';
import { Public } from '../auth/decorators.js';
import { BRIDGE_RATE_LIMITS, BRIDGE_SETTINGS, type BridgeSettings } from './bridge.config.js';
import { BridgeCallsService } from './bridge-calls.service.js';
import {
  BRIDGE_PROVIDER,
  type BridgeProvider,
  type BridgeWebhookSink,
  WebhookRejectedError,
} from './provider/bridge-provider.js';

const rejected = (): ApiException =>
  new ApiException(HttpStatus.UNAUTHORIZED, 'WEBHOOK_REJECTED', 'Webhook rejected');

/** Authenticates provider webhooks and hands the events to the call service. */
@Injectable()
export class BridgeWebhookService implements BridgeWebhookSink {
  constructor(
    private readonly calls: BridgeCallsService,
    private readonly audit: AuditService,
    @Inject(BRIDGE_SETTINGS) private readonly settings: BridgeSettings,
    @Inject(BRIDGE_PROVIDER) private readonly provider: BridgeProvider,
  ) {}

  async deliver(
    provider: string,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    ip?: string,
  ): Promise<void> {
    if (!this.settings.enabled || provider !== this.provider.name) throw rejected();
    let events;
    try {
      events = this.provider.parseWebhook(rawBody, headers, new Date());
    } catch (error) {
      if (!(error instanceof WebhookRejectedError)) throw error;
      // Never the body or headers: only that a webhook was refused, and why in one word.
      await this.audit.record({
        type: 'BRIDGE_WEBHOOK_REJECTED',
        meta: ip ? { ipAddress: ip } : undefined,
        details: { provider, reason: error.message },
      });
      throw rejected();
    }
    await this.calls.applyEvents(provider, events);
  }
}

@Controller('bridge/webhooks')
export class BridgeWebhooksController {
  constructor(private readonly webhooks: BridgeWebhookService) {}

  @Public()
  @Post(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: BRIDGE_RATE_LIMITS.webhook })
  async receive(@Param('provider') provider: string, @Req() req: Request): Promise<void> {
    const raw: unknown = req.body;
    if (!Buffer.isBuffer(raw)) throw rejected();
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
    }
    await this.webhooks.deliver(
      provider.slice(0, 32),
      raw,
      headers,
      requestMeta(req).ipAddress ?? undefined,
    );
  }
}
