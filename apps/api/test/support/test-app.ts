import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Controller, Get, type INestApplication, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AuthResponse } from '@ogc/types';
import request from 'supertest';
import { expect } from 'vitest';
import { LOG_DESTINATION } from '../../src/common/logging/log-destination.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { AuthContext } from '../../src/modules/auth/auth-context.js';
import { CurrentAuth } from '../../src/modules/auth/decorators.js';
import { type EmailMessage, EmailSender } from '../../src/modules/email/email-sender.js';
import {
  RANDOM_INT_SOURCE,
  type RandomIntSource,
} from '../../src/modules/identity/ogc-id.generator.js';

/** The server type accepted by supertest's `request()`. */
export type HttpServer = Parameters<typeof request>[0];

export const PASSWORD = 'correct horse battery staple';

/** Captures outgoing email instead of delivering it. */
export class MemoryEmailSender extends EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  lastTo(address: string): EmailMessage | undefined {
    return this.sent.filter((m) => m.to === address).at(-1);
  }
}

/** A stand-in for future feature endpoints: protected with the default (ACTIVE-only) policy. */
@Controller('test-protected')
class ProtectedTestController {
  @Get()
  whoami(@CurrentAuth() auth: AuthContext): { ogcId: string } {
    return { ogcId: auth.ogcId };
  }
}

export interface TestApp {
  app: INestApplication;
  server: HttpServer;
  prisma: PrismaService;
  emails: MemoryEmailSender;
  logs: () => string;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  randomSource?: RandomIntSource;
  extraControllers?: Type[];
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  // Imported lazily so a test file can adjust process.env (e.g. LOG_LEVEL) first.
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/bootstrap/configure-app.js');

  const emails = new MemoryEmailSender();
  const logStream = new PassThrough();
  const chunks: string[] = [];
  logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProtectedTestController, ...(options.extraControllers ?? [])],
  })
    .overrideProvider(EmailSender)
    .useValue(emails)
    .overrideProvider(LOG_DESTINATION)
    .useValue(logStream);
  if (options.randomSource) {
    builder = builder.overrideProvider(RANDOM_INT_SOURCE).useValue(options.randomSource);
  }
  const moduleRef = await builder.compile();

  const nestApp = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(nestApp);
  const app = await nestApp.init();

  return {
    app,
    server: app.getHttpServer() as HttpServer,
    prisma: app.get(PrismaService),
    emails,
    logs: () => chunks.join(''),
    close: () => app.close(),
  };
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

/** A random client IP, so per-IP rate limits do not couple unrelated tests. */
export function clientIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export function verificationTokenFrom(message: EmailMessage | undefined): string {
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(message?.text ?? '')?.[1];
  if (!token) throw new Error('No verification token in email');
  return token;
}

export function register(
  t: TestApp,
  email: string,
  password = PASSWORD,
  displayName = 'Test User',
): request.Test {
  return request(t.server)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', clientIp())
    .send({ email, password, displayName });
}

/** Registers and verifies an account, returning its email address. */
export async function createActiveAccount(t: TestApp, password = PASSWORD): Promise<string> {
  const email = uniqueEmail();
  expect((await register(t, email, password)).status).toBe(202);
  const token = verificationTokenFrom(t.emails.lastTo(email));
  await request(t.server)
    .post('/api/v1/auth/verify-email')
    .set('X-Forwarded-For', clientIp())
    .send({ token })
    .expect(200);
  return email;
}

export async function nativeLogin(
  t: TestApp,
  email: string,
  password = PASSWORD,
): Promise<{ status: number; body: AuthResponse & Record<string, unknown> }> {
  const res = await request(t.server)
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', clientIp())
    .send({ email, password, device: { platform: 'ANDROID', name: 'Test phone' } });
  return { status: res.status, body: res.body as AuthResponse & Record<string, unknown> };
}

/** Logs in as a native client and returns its bearer tokens. */
export async function nativeTokens(
  t: TestApp,
  email: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const { status, body } = await nativeLogin(t, email);
  expect(status).toBe(200);
  if (!body.tokens) throw new Error('Expected tokens in native login response');
  return body.tokens;
}

/** Turns Set-Cookie headers into a Cookie request header. */
export function cookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  return list
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

export function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}
