import { Body, Controller, Delete, HttpCode, HttpStatus, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { PushProviderName } from '@ogc/types';
import { pushTokenRequestSchema } from '@ogc/validation';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { NotificationsService } from './notifications.service.js';

/** `/api/v1/notifications/push-token` — the push token of the *current* device only. */
@Controller('notifications/push-token')
@Throttle({ default: throttle('e2ee') })
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
