import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { CommunityNotificationsService } from './community-notifications.service.js';
import { InboxController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import {
  DisabledPushProvider,
  ExpoPushProvider,
  OutboxPushProvider,
  PushProvider,
} from './push-provider.js';

@Module({
  controllers: [NotificationsController, InboxController],
  providers: [
    NotificationsService,
    CommunityNotificationsService,
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
  exports: [NotificationsService, CommunityNotificationsService],
})
export class NotificationsModule {}
