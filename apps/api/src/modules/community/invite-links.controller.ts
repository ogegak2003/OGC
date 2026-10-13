import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { InvitePreview, JoinResult } from '@ogc/types';
import { inviteTokenSchema, uuidSchema } from '@ogc/validation';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { InviteLinksService } from './invite-links.service.js';

const tokenBody = new ZodValidationPipe(z.strictObject({ token: inviteTokenSchema }));

/**
 * `/api/v1/invite-links` — tokens travel in request bodies only (never in URLs,
 * which end up in logs and browser history). Previews and joins share a
 * strict per-account limit, which together with 256-bit tokens makes guessing
 * impossible in practice.
 */
@Controller('invite-links')
@Throttle({ default: throttle('inviteLinkJoin') })
export class InviteLinksController {
  constructor(private readonly links: InviteLinksService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Body(tokenBody) body: { token: string },
  ): Promise<InvitePreview> {
    return this.links.preview(auth.userId, body.token);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  join(
    @CurrentAuth() auth: AuthContext,
    @Body(tokenBody) body: { token: string },
  ): Promise<JoinResult> {
    return this.links.join(auth, body.token);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('communityManage') })
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.links.revoke(auth, id, requestMeta(req));
  }
}
