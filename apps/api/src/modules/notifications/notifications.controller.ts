import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { NotificationPage, NotificationSettingsView, PushProviderName } from '@ogc/types';
import {
  type NotificationSettingsUpdate,
  type PageQuery,
  markNotificationsReadSchema,
  notificationSettingsUpdateSchema,
  pageQuerySchema,
  pushTokenRequestSchema,
} from '@ogc/validation';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { CommunityNotificationsService } from './community-notifications.service.js';
import { NotificationsService } from './notifications.service.js';

/** `/api/v1/notifications/push-token` — the push token of the *current* device only. */
@Controller('notifications/push-token')
@Throttle({ default: throttle('pushRegister') })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  register(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(pushTokenRequestSchema))
    body: { provider: PushProviderName; token: string },
  ): Promise<void> {
    return this.notifications.register(auth, body.provider, body.token);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  unregister(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.notifications.unregister(auth);
  }
}

/** `/api/v1/notifications` — the caller's in-app notifications (IDs and public names only). */
@Controller('notifications')
@Throttle({ default: throttle('notifications') })
export class InboxController {
  constructor(private readonly notifications: CommunityNotificationsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(auth.userId, query.cursor, query.limit);
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(markNotificationsReadSchema))
    body: { ids: string[] } | { all: true },
  ): Promise<void> {
    return this.notifications.markRead(auth.userId, 'all' in body ? 'all' : body.ids);
  }
}

/**
 * `/api/v1/notifications/settings` — the signed-in account's push preferences (synchronised
 * across its devices). Validated strictly on the server; there is no way to address another
 * account.
 */
@Controller('notifications/settings')
@Throttle({ default: throttle('notifications') })
export class NotificationSettingsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<NotificationSettingsView> {
    return this.notifications.settings(auth.userId);
  }

  @Put()
  update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(notificationSettingsUpdateSchema)) body: NotificationSettingsUpdate,
  ): Promise<NotificationSettingsView> {
    return this.notifications.updateSettings(auth.userId, body);
  }
}
