import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { ApiErrorBody, HealthResponse } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap/configure-app.js';
import { PrismaService } from '../src/database/prisma.service.js';

/** The server type accepted by supertest's `request()`. */
type App = Parameters<typeof request>[0];

@Controller('test-errors')
class ThrowingController {
  @Get()
  fail(): never {
    throw new Error('internal detail: connection string postgres://secret');
  }
}

describe('API (e2e)', () => {
  let app: INestApplication;
  let server: App;
  const prisma = { isReachable: vi.fn<() => Promise<boolean>>(), onModuleDestroy: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowingController],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    const nestApp = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(nestApp);
    app = await nestApp.init();
    server = app.getHttpServer() as App;
  });

  beforeEach(() => {
    prisma.isReachable.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health reports liveness', async () => {
    const res = await request(server).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'ogc-api' });
    expect(typeof (res.body as HealthResponse).timestamp).toBe('string');
  });

  it('GET /api/v1/health/ready is 200 when the database is reachable', async () => {
    prisma.isReachable.mockResolvedValue(true);
    const res = await request(server).get('/api/v1/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('GET /api/v1/health/ready is 503 when the database is unreachable', async () => {
    prisma.isReachable.mockResolvedValue(false);
    const res = await request(server).get('/api/v1/health/ready').expect(503);
    expect(res.body).toMatchObject({ status: 'down', checks: { database: 'down' } });
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(server).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('issues a request id, or echoes a safe caller-supplied one', async () => {
    const generated = await request(server).get('/api/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = await request(server)
      .get('/api/v1/health')
      .set('X-Request-Id', 'client-req-12345');
    expect(supplied.headers['x-request-id']).toBe('client-req-12345');

    const unsafe = await request(server)
      .get('/api/v1/health')
      .set('X-Request-Id', 'bad id <script>');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows configured CORS origins only', async () => {
    const allowed = await request(server)
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(server)
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(server).get('/api/v1/does-not-exist').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: 'NOT_FOUND' });
    expect(typeof (res.body as ApiErrorBody).requestId).toBe('string');
  });

  it('does not leak internal error details', async () => {
    const res = await request(server).get('/api/v1/test-errors').expect(500);
    expect(res.body).toMatchObject({ statusCode: 500, message: 'An unexpected error occurred' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(res.body).not.toHaveProperty('stack');
  });

  it('rejects oversized request bodies with a structured 413', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(200 * 1024) });
    const res = await request(server)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(big)
      .expect(413);
    expect(res.body).toMatchObject({ statusCode: 413, error: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects malformed JSON with a structured 400', async () => {
    const res = await request(server)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"unterminated":')
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'BAD_REQUEST' });
  });
});
