import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import {
  DisabledPushProvider,
  ExpoPushProvider,
  OutboxPushProvider,
  PushProvider,
} from './push-provider.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: PushProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PushProvider => {
        switch (config.get('PUSH_PROVIDER', { infer: true })) {
          case 'expo':
            return new ExpoPushProvider(config.get('EXPO_ACCESS_TOKEN', { infer: true }));
          case 'outbox':
            return new OutboxPushProvider(config.get('PUSH_OUTBOX_DIR', { infer: true }));
          default:
            return new DisabledPushProvider();
        }
      },
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
