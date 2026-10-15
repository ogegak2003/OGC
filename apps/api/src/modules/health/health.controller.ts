import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthResponse, HealthStatus, ReadinessResponse } from '@ogc/types';
import type { Response } from 'express';
import { RedisConnections } from '../../common/redis/redis.module.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../../service-info.js';
import { Public } from '../auth/decorators.js';

/** Each dependency check must answer within this time, or it counts as down. */
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

function within<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, READINESS_CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * `GET /health` is liveness (the process runs; container restarts key off it). `GET
 * /health/ready` is readiness (send traffic here?): the database answers, no migration is
 * failed or half-applied, Redis answers when configured, and the process is not shutting
 * down. Load balancers and the deployment's startup ordering use readiness. Neither endpoint
 * reveals more than ok/down per check.
 */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController implements BeforeApplicationShutdown {
  private readonly logger = new Logger(HealthController.name);
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisConnections,
  ) {}

  /**
   * On SIGTERM: report not-ready at once, so health-checking load balancers and orchestrators
   * stop routing here before the server closes. (The bundled nginx edge does not health-check.)
   */
  beforeApplicationShutdown(signal?: string): void {
    this.draining = true;
    this.logger.log({ signal }, 'Shutting down: readiness now reports down');
  }

  /** Liveness: the process is running. Does not touch dependencies. */
  @Get()
  @HttpCode(HttpStatus.OK)
  live(): HealthResponse {
    return this.snapshot('ok');
  }

  /** Readiness: dependencies are reachable and the schema is complete. 503 otherwise. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const ok = (up: boolean): HealthStatus => (up ? 'ok' : 'down');
    const [database, migrations, redis] = await Promise.all([
      within(this.prisma.isReachable(), false),
      within(this.prisma.migrationsComplete(), false),
      this.redis.client
        ? within(
            this.redis.client.ping().then(() => true),
            false,
          )
        : Promise.resolve(undefined),
    ]);
    const checks: Record<string, HealthStatus> = {
      database: ok(database),
      migrations: ok(database && migrations),
      ...(redis === undefined ? {} : { redis: ok(redis) }),
      process: ok(!this.draining),
    };
    const status = Object.values(checks).every((check) => check === 'ok') ? 'ok' : 'down';
    res.status(status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    res.setHeader('Cache-Control', 'no-store');
    return { ...this.snapshot(status), checks };
  }

  private snapshot(status: HealthResponse['status']): HealthResponse {
    return {
      status,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
    };
  }
}
