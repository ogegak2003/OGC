import type { ReadinessResponse } from '@ogc/types';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisConnections } from '../../common/redis/redis.module.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { HealthController, READINESS_CHECK_TIMEOUT_MS } from './health.controller.js';

function fakeResponse() {
  const res = { statusCode: 200, headers: {} as Record<string, string> };
  const response = {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
  };
  return { res, response: response as unknown as Response };
}

function controller(options: {
  database?: () => Promise<boolean>;
  migrations?: () => Promise<boolean>;
  ping?: (() => Promise<string>) | null;
}) {
  const prisma = {
    isReachable: options.database ?? (() => Promise.resolve(true)),
    migrationsComplete: options.migrations ?? (() => Promise.resolve(true)),
  } as unknown as PrismaService;
  const redis = {
    client: options.ping === null || options.ping === undefined ? null : { ping: options.ping },
  } as unknown as RedisConnections;
  return new HealthController(prisma, redis);
}

async function ready(
  health: HealthController,
): Promise<{ status: number; body: ReadinessResponse }> {
  const { res, response } = fakeResponse();
  const body = await health.ready(response);
  return { status: res.statusCode, body };
}

describe('readiness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is ready when the database, migrations and Redis answer', async () => {
    const result = await ready(controller({ ping: () => Promise.resolve('PONG') }));
    expect(result.status).toBe(200);
    expect(result.body.checks).toEqual({
      database: 'ok',
      migrations: 'ok',
      redis: 'ok',
      process: 'ok',
    });
  });

  it('omits Redis when it is not configured (single development instance)', async () => {
    const result = await ready(controller({ ping: null }));
    expect(result.status).toBe(200);
    expect(result.body.checks).not.toHaveProperty('redis');
  });

  it('is not ready when Redis fails or hangs', async () => {
    const failing = await ready(
      controller({ ping: () => Promise.reject(new Error('connection refused')) }),
    );
    expect(failing.status).toBe(503);
    expect(failing.body.checks.redis).toBe('down');

    vi.useFakeTimers();
    const pending = ready(controller({ ping: () => new Promise<string>(() => undefined) }));
    await vi.advanceTimersByTimeAsync(READINESS_CHECK_TIMEOUT_MS + 10);
    const hanging = await pending;
    expect(hanging.status).toBe(503);
    expect(hanging.body.checks.redis).toBe('down');
  });

  it('reports migrations down when the database itself is down', async () => {
    const result = await ready(
      controller({
        database: () => Promise.resolve(false),
        migrations: () => Promise.resolve(true),
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body.checks).toMatchObject({ database: 'down', migrations: 'down' });
  });

  it('reports not ready from the moment shutdown starts, while staying alive', async () => {
    const health = controller({ ping: () => Promise.resolve('PONG') });
    health.beforeApplicationShutdown('SIGTERM');
    const result = await ready(health);
    expect(result.status).toBe(503);
    expect(result.body.checks.process).toBe('down');
    expect(health.live().status).toBe('ok');
  });

  it('never includes error details', async () => {
    const result = await ready(
      controller({
        database: () => Promise.reject(new Error('password authentication failed for user "ogc"')),
        ping: () => Promise.reject(new Error('WRONGPASS invalid username-password pair')),
      }),
    );
    const text = JSON.stringify(result.body);
    expect(text).not.toMatch(/password|WRONGPASS|ogc"/);
  });
});
