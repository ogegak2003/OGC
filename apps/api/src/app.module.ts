import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { DomainEventsModule } from './common/events/domain-events.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import {
  LOG_DESTINATION,
  type LogDestination,
  LogDestinationModule,
} from './common/logging/log-destination.module.js';
import { loggerConfig } from './common/logging/logger.config.js';
import { OgcThrottlerGuard } from './common/throttling/ogc-throttler.guard.js';
import { type Env, validateEnv } from './config/env.schema.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BlocksModule } from './modules/blocks/blocks.module.js';
import { ContactsModule } from './modules/contacts/contacts.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { StorageModule } from './modules/storage/storage.module.js';

/**
 * Root module of the modular monolith. Each business domain lives in its own
 * module under src/modules (see docs/architecture/overview.md).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Local convenience only; real process environment variables take precedence.
      envFilePath: '.env',
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      imports: [LogDestinationModule],
      inject: [ConfigService, LOG_DESTINATION],
      useFactory: (config: ConfigService<Env, true>, destination: LogDestination) =>
        loggerConfig(
          {
            LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
            NODE_ENV: config.get('NODE_ENV', { infer: true }),
          },
          destination,
        ),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [
        {
          ttl: config.get('RATE_LIMIT_TTL_MS', { infer: true }),
          limit: config.get('RATE_LIMIT_MAX', { infer: true }),
        },
      ],
    }),
    DatabaseModule,
    DomainEventsModule,
    StorageModule,
    HealthModule,
    AuthModule,
    ProfilesModule,
    ContactsModule,
    BlocksModule,
    ReportsModule,
  ],
  providers: [
    // Order matters: authentication first, so rate limits can be keyed per account
    // for signed-in requests (per IP for anonymous ones).
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useClass: OgcThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
