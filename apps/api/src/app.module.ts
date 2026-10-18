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
import { MetricsModule } from './common/metrics/metrics.js';
import { RedisConnections, RedisModule } from './common/redis/redis.module.js';
import { OgcThrottlerGuard } from './common/throttling/ogc-throttler.guard.js';
import { messagingLimitsFrom, setMessagingLimits } from './common/throttling/rate-limits.js';
import { RedisThrottlerStorage } from './common/throttling/redis-throttler.storage.js';
import { type Env, validateEnv } from './config/env.schema.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BlocksModule } from './modules/blocks/blocks.module.js';
import { BridgeModule } from './modules/bridge/bridge.module.js';
import { CallsModule } from './modules/calls/calls.module.js';
import { CommunityModule } from './modules/community/community.module.js';
import { ContactsModule } from './modules/contacts/contacts.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { E2eeModule } from './modules/e2ee/e2ee.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { RealtimeCoreModule, RealtimeGatewayModule } from './modules/realtime/realtime.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { RetentionModule } from './modules/retention/retention.module.js';
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
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisConnections],
      useFactory: (config: ConfigService<Env, true>, redis: RedisConnections) => {
        setMessagingLimits(messagingLimitsFrom((key) => config.get(key, { infer: true })));
        return {
          // Shared across API instances when Redis is configured; in-process otherwise.
          ...(redis.client ? { storage: new RedisThrottlerStorage(redis.client) } : {}),
          throttlers: [
            {
              ttl: config.get('RATE_LIMIT_TTL_MS', { infer: true }),
              limit: config.get('RATE_LIMIT_MAX', { infer: true }),
            },
          ],
        };
      },
    }),
    DatabaseModule,
    MetricsModule,
    RealtimeCoreModule,
    DomainEventsModule,
    StorageModule,
    HealthModule,
    AuthModule,
    ProfilesModule,
    ContactsModule,
    BlocksModule,
    ReportsModule,
    E2eeModule,
    ConversationsModule,
    AttachmentsModule,
    NotificationsModule,
    CommunityModule,
    CallsModule,
    BridgeModule,
    RetentionModule,
    RealtimeGatewayModule,
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
