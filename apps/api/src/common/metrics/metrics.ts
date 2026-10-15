import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Global,
  Header,
  HttpStatus,
  Injectable,
  Module,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Env } from '../../config/env.schema.js';
import { Public } from '../../modules/auth/decorators.js';
import { ApiException } from '../errors.js';

/**
 * Operational metrics (Prometheus format). Labels are low-cardinality enums
 * only — never user, conversation or message identifiers, and never content.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly socketConnections = new Gauge({
    name: 'ogc_realtime_connections',
    help: 'Open realtime (WebSocket) connections on this instance',
    registers: [this.registry],
  });

  readonly messagesSent = new Counter({
    name: 'ogc_messages_sent_total',
    help: 'Encrypted messages accepted by the API',
    registers: [this.registry],
  });

  readonly channelPosts = new Counter({
    name: 'ogc_channel_posts_total',
    help: 'Community channel posts accepted (server-readable)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly communityEvents = new Counter({
    name: 'ogc_community_events_total',
    help: 'Group and channel membership, invitation and moderation events',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });

  readonly deliveryLatency = new Histogram({
    name: 'ogc_message_delivery_latency_seconds',
    help: 'Time from message acceptance to the first delivery receipt',
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60, 300, 3600],
    registers: [this.registry],
  });

  readonly failures = new Counter({
    name: 'ogc_messaging_failures_total',
    help: 'Rejected or failed messaging operations by kind',
    labelNames: ['operation', 'reason'] as const,
    registers: [this.registry],
  });

  readonly callsStarted = new Counter({
    name: 'ogc_calls_started_total',
    help: 'Calls started, by media type',
    labelNames: ['media'] as const,
    registers: [this.registry],
  });

  readonly callsEnded = new Counter({
    name: 'ogc_calls_ended_total',
    help: 'Calls ended, by media type and outcome',
    labelNames: ['media', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly openCalls = new Gauge({
    name: 'ogc_calls_open',
    help: 'Calls ringing or in progress (as seen by the last sweep on this instance)',
    registers: [this.registry],
  });

  readonly pushDeliveries = new Counter({
    name: 'ogc_push_deliveries_total',
    help: 'Push deliveries by category and outcome (queued, sent, delivered, retried, failed, expired)',
    labelNames: ['category', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly pushErrors = new Counter({
    name: 'ogc_push_errors_total',
    help: 'Push provider errors by code (e.g. DeviceNotRegistered, HTTP_503, NETWORK)',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });

  readonly pushBacklog = new Gauge({
    name: 'ogc_push_queue_pending',
    help: 'Pushes waiting to be sent (as seen by the last check on this instance)',
    registers: [this.registry],
  });

  readonly pushOldestPendingSeconds = new Gauge({
    name: 'ogc_push_queue_oldest_pending_seconds',
    help: 'Age of the oldest pending push (alert when it keeps growing)',
    registers: [this.registry],
  });

  readonly rateLimited = new Counter({
    name: 'ogc_rate_limited_total',
    help: 'Requests and realtime events rejected by rate limits',
    labelNames: ['scope'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'ogc_' });
  }
}

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * `GET /api/v1/metrics`, for the monitoring system only: requires
 * `Authorization: Bearer <METRICS_TOKEN>` and answers 404 when no token is configured.
 */
@Controller('metrics')
@Public()
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Req() req: Request): Promise<string> {
    const token = this.config.get('METRICS_TOKEN', { infer: true });
    if (!token) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    const presented = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
    if (!presented || !sameSecret(presented, token)) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Authentication required');
    }
    req.res?.type(this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
