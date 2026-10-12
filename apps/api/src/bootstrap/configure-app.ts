import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from '../config/env.schema.js';

export const API_PREFIX = 'api';
export const BODY_SIZE_LIMIT = '100kb';

/**
 * Applies the HTTP security baseline and routing conventions. Shared by
 * `main.ts` and the end-to-end tests so tests exercise the real setup.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  app.flushLogs();

  app.disable('x-powered-by');
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  app.use(helmet());
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-OGC-Client'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  // Unsigned: auth cookies hold opaque random tokens validated server-side.
  app.use(cookieParser());
  app.useBodyParser('json', { limit: BODY_SIZE_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_SIZE_LIMIT, extended: false });

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
}
