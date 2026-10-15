import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap/configure-app.js';
import { type StartupEnv, startupNotices } from './bootstrap/startup-report.js';
import type { Env } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }), config.get('HOST', { infer: true }));

  const logger = new Logger('Startup');
  for (const notice of startupNotices(validatedEnv(config))) {
    logger[notice.level]({ feature: notice.feature }, notice.message);
  }
}

function validatedEnv(config: ConfigService<Env, true>): StartupEnv {
  const get = <K extends keyof StartupEnv>(key: K): StartupEnv[K] =>
    config.get(key, { infer: true });
  return {
    NODE_ENV: get('NODE_ENV'),
    EMAIL_TRANSPORT: get('EMAIL_TRANSPORT'),
    STORAGE_DRIVER: get('STORAGE_DRIVER'),
    PUSH_PROVIDER: get('PUSH_PROVIDER'),
    WEBRTC_TURN_URLS: get('WEBRTC_TURN_URLS'),
    METRICS_TOKEN: get('METRICS_TOKEN'),
    DATABASE_TLS: get('DATABASE_TLS'),
    REDIS_TLS: get('REDIS_TLS'),
  };
}

await bootstrap();
