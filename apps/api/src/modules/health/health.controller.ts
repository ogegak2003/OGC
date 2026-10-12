import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthResponse, ReadinessResponse } from '@ogc/types';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../../service-info.js';
import { Public } from '../auth/decorators.js';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is running. Does not touch dependencies. */
  @Get()
  @HttpCode(HttpStatus.OK)
  live(): HealthResponse {
    return this.snapshot('ok');
  }

  /** Readiness: dependencies are reachable. Returns 503 when they are not. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const database = (await this.prisma.isReachable()) ? 'ok' : 'down';
    const status = database === 'ok' ? 'ok' : 'down';
    res.status(status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { ...this.snapshot(status), checks: { database } };
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
