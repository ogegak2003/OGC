import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type {
  AttachmentKind,
  ChannelAttachmentView,
  ChannelMemberView,
  ChannelPostPage,
  ChannelPostReportView,
  ChannelPostView,
  ChannelSyncPage,
  ChannelView,
  CreatedInviteLink,
  InviteLinkView,
  JoinResult,
  ModerationActionView,
  NotificationPreferences,
  OgcId,
  Page,
  ReactionType,
  ReportCategory,
  VisibilityChangeResult,
} from '@ogc/types';
import {
  ATTACHMENT_MAX_BYTES,
  changeVisibilityRequestSchema,
  channelFeedQuerySchema,
  channelHandleSchema,
  channelMediaFieldsSchema,
  channelMembersQuerySchema,
  channelPostRequestSchema,
  channelSearchQuerySchema,
  channelSyncQuerySchema,
  createChannelRequestSchema,
  createInviteLinkRequestSchema,
  editChannelPostRequestSchema,
  moderationReasonSchema,
  notificationPreferencesSchema,
  ogcIdInputSchema,
  pageQuerySchema,
  reactionTypeSchema,
  receiptRequestSchema,
  reportPostRequestSchema,
  resolveReportRequestSchema,
  roleChangeRequestSchema,
  suspendMemberRequestSchema,
  transferOwnershipRequestSchema,
  updateChannelRequestSchema,
  uuidSchema,
  type PageQuery,
} from '@ogc/validation';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiException } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { InviteLinksService } from '../community/invite-links.service.js';
import { AVATAR_MAX_BYTES, invalidMedia } from '../profiles/avatar-image.js';
import { ChannelMediaService } from './channel-media.service.js';
import { ChannelModerationService } from './channel-moderation.service.js';
import { type ChannelPostInput, ChannelPostsService } from './channel-posts.service.js';
import {
  ChannelsService,
  type CreateChannelInput,
  type UpdateChannelInput,
} from './channels.service.js';

const idParam = new ZodValidationPipe(uuidSchema);
const ogcIdParam = new ZodValidationPipe(ogcIdInputSchema);
const reactionParam = new ZodValidationPipe(reactionTypeSchema);
const reportStatusQuery = z
  .strictObject({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).default('OPEN') })
  .extend(pageQuerySchema.shape);
const threadQuery = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * `/api/v1/channels` — community channels. These are server-readable (NOT
 * end-to-end encrypted); responses say so in `endToEndEncrypted: false`.
 */
@Controller('channels')
@Throttle({ default: throttle('communityManage') })
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly posts: ChannelPostsService,
    private readonly moderation: ChannelModerationService,
    private readonly links: InviteLinksService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('communityCreate') })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createChannelRequestSchema)) body: CreateChannelInput,
    @Req() req: Request,
  ): Promise<ChannelView> {
    return this.channels.create(auth, body, requestMeta(req));
  }

  @Get()
  @Throttle({ default: throttle('sync') })
  mine(@CurrentAuth() auth: AuthContext): Promise<ChannelView[]> {
    return this.channels.mine(auth.userId);
  }

  /** Public channel directory and search (private channels are never listed). */
  @Get('discover')
  @Throttle({ default: throttle('discovery') })
  discover(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(channelSearchQuerySchema))
    query: { q?: string; cursor?: string; limit: number },
  ): Promise<Page<ChannelView>> {
    return this.channels.discover(auth.userId, query);
  }

  @Get('by-handle/:handle')
  @Throttle({ default: throttle('discovery') })
  byHandle(
    @CurrentAuth() auth: AuthContext,
    @Param('handle', new ZodValidationPipe(channelHandleSchema)) handle: string,
  ): Promise<ChannelView> {
    return this.channels.byHandle(auth.userId, handle);
  }

  @Get(':id')
  @Throttle({ default: throttle('sync') })
  view(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<ChannelView> {
    return this.channels.view(auth.userId, id);
  }

  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateChannelRequestSchema)) body: UpdateChannelInput,
  ): Promise<ChannelView> {
    return this.channels.update(auth, id, body);
  }

  /** Requires `confirm: true`; the response lists the consequences that apply. */
  @Post(':id/visibility')
  @HttpCode(HttpStatus.OK)
  changeVisibility(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(changeVisibilityRequestSchema))
    body: { visibility: 'PUBLIC' | 'PRIVATE'; confirm: true },
    @Req() req: Request,
  ): Promise<VisibilityChangeResult> {
    return this.channels.changeVisibility(auth, id, body.visibility, requestMeta(req));
  }

  @Post(':id/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseInterceptors(
    FileInterceptor('avatar', {
      limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 },
    }),
  )
  async setAvatar(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<void> {
    if (!file) throw invalidMedia('Attach an image in the "avatar" field');
    await this.channels.setAvatar(auth, id, file.buffer);
  }

  @Delete(':id/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAvatar(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.channels.removeAvatar(auth, id);
  }

  @Get(':id/avatar')
  @Throttle({ default: throttle('sync') })
  @Header('Content-Type', 'image/webp')
  @Header('Cache-Control', 'private, max-age=3600')
  @Header('Content-Disposition', 'inline')
  async avatar(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const data = await this.channels.avatar(auth.userId, id);
    res.setHeader('Content-Length', data.length);
    return new StreamableFile(data);
  }

  @Post(':id/join')
  join(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<JoinResult> {
    return this.channels.join(auth, id);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.channels.leave(auth, id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('receipt') })
  read(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(receiptRequestSchema)) body: { seq: number },
  ): Promise<void> {
    return this.channels.markRead(auth, id, body.seq);
  }

  @Put(':id/notifications')
  preferences(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(notificationPreferencesSchema))
    body: { level?: 'ALL' | 'MENTIONS' | 'NONE'; mutedUntil?: string | null },
  ): Promise<NotificationPreferences> {
    return this.channels.setPreferences(auth, id, body);
  }

  @Get(':id/members')
  @Throttle({ default: throttle('sync') })
  members(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(channelMembersQuerySchema))
    query: { status?: 'ACTIVE' | 'PENDING' | 'BANNED'; cursor?: string; limit: number },
  ): Promise<Page<ChannelMemberView>> {
    return this.channels.members(auth.userId, id, query);
  }

  @Put(':id/members/:ogcId/role')
  @HttpCode(HttpStatus.NO_CONTENT)
  changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Body(new ZodValidationPipe(roleChangeRequestSchema))
    body: { role: 'ADMIN' | 'MODERATOR' | 'MEMBER' },
  ): Promise<void> {
    return this.channels.changeRole(auth, id, ogcId, body.role);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.NO_CONTENT)
  transfer(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(transferOwnershipRequestSchema)) body: { ogcId: OgcId },
    @Req() req: Request,
  ): Promise<void> {
    return this.channels.transferOwnership(auth, id, body.ogcId, requestMeta(req));
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.channels.setArchived(auth, id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.NO_CONTENT)
  unarchive(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.channels.setArchived(auth, id, false);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.channels.delete(auth, id, requestMeta(req));
  }

  // Posts --------------------------------------------------------------------

  @Get(':id/posts')
  @Throttle({ default: throttle('sync') })
  feed(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(channelFeedQuerySchema))
    query: { before?: number; q?: string; limit: number },
  ): Promise<ChannelPostPage> {
    return this.posts.feed(auth.userId, id, query);
  }

  @Post(':id/posts')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('channelPost') })
  post(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(channelPostRequestSchema)) body: ChannelPostInput,
  ): Promise<ChannelPostView> {
    return this.posts.create(auth, id, body);
  }

  @Get(':id/pinned')
  @Throttle({ default: throttle('sync') })
  pinned(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<ChannelPostView[]> {
    return this.posts.pinned(auth.userId, id);
  }

  @Get(':id/sync')
  @Throttle({ default: throttle('sync') })
  sync(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(channelSyncQuerySchema)) query: { after: number; limit: number },
  ): Promise<ChannelSyncPage> {
    return this.posts.sync(auth.userId, id, query.after, query.limit);
  }

  // Moderation ---------------------------------------------------------------

  @Post(':id/members/:ogcId/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Body(new ZodValidationPipe(suspendMemberRequestSchema))
    body: { hours: number; reason?: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.suspend(auth, id, ogcId, body.hours, body.reason, requestMeta(req));
  }

  @Delete(':id/members/:ogcId/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  unsuspend(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.suspend(auth, id, ogcId, 0, undefined, requestMeta(req));
  }

  @Delete(':id/members/:ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Body(new ZodValidationPipe(moderationReasonSchema)) body: { reason?: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.removeMember(auth, id, ogcId, body.reason, requestMeta(req));
  }

  @Post(':id/bans/:ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  ban(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Body(new ZodValidationPipe(moderationReasonSchema)) body: { reason?: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.ban(auth, id, ogcId, body.reason, requestMeta(req));
  }

  @Delete(':id/bans/:ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  unban(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Body(new ZodValidationPipe(moderationReasonSchema)) body: { reason?: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.unban(auth, id, ogcId, body.reason, requestMeta(req));
  }

  @Post(':id/requests/:ogcId/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.decideRequest(auth, id, ogcId, true, requestMeta(req));
  }

  @Post(':id/requests/:ogcId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.decideRequest(auth, id, ogcId, false, requestMeta(req));
  }

  @Get(':id/reports')
  reports(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(reportStatusQuery))
    query: PageQuery & { status: 'OPEN' | 'RESOLVED' | 'DISMISSED' },
  ): Promise<Page<ChannelPostReportView>> {
    return this.moderation.reports(auth, id, query.status, query);
  }

  @Get(':id/moderation')
  history(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery,
  ): Promise<Page<ModerationActionView>> {
    return this.moderation.history(auth, id, query);
  }

  // Invitation links -----------------------------------------------------------

  @Post(':id/invite-links')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('invite') })
  createLink(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(createInviteLinkRequestSchema))
    body: { expiresInHours: number; maxUses?: number },
    @Req() req: Request,
  ): Promise<CreatedInviteLink> {
    return this.links.create(auth, { channelId: id }, body, requestMeta(req));
  }

  @Get(':id/invite-links')
  listLinks(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<InviteLinkView[]> {
    return this.links.list(auth, { channelId: id });
  }
}

/** `/api/v1/channel-posts/:id` — individual posts. */
@Controller('channel-posts')
@Throttle({ default: throttle('channelPost') })
export class ChannelPostsController {
  constructor(
    private readonly posts: ChannelPostsService,
    private readonly moderation: ChannelModerationService,
  ) {}

  @Get(':id/thread')
  @Throttle({ default: throttle('sync') })
  thread(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(threadQuery)) query: { after?: number; limit: number },
  ): Promise<{ post: ChannelPostView; replies: ChannelPostPage }> {
    return this.posts.thread(auth.userId, id, query);
  }

  @Patch(':id')
  edit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(editChannelPostRequestSchema)) body: { body: string },
  ): Promise<ChannelPostView> {
    return this.posts.edit(auth, id, body.body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.posts.delete(auth, id);
  }

  @Put(':id/reactions/:reaction')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('reaction') })
  react(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('reaction', reactionParam) reaction: ReactionType,
  ): Promise<void> {
    return this.posts.react(auth, id, reaction, true);
  }

  @Delete(':id/reactions/:reaction')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('reaction') })
  unreact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('reaction', reactionParam) reaction: ReactionType,
  ): Promise<void> {
    return this.posts.react(auth, id, reaction, false);
  }

  @Put(':id/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  pin(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.posts.setPinned(auth, id, true);
  }

  @Delete(':id/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  unpin(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.posts.setPinned(auth, id, false);
  }

  @Post(':id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(moderationReasonSchema)) body: { reason?: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.setRemoved(auth, id, true, body.reason, requestMeta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('moderation') })
  restore(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(moderationReasonSchema)) body: { reason?: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.setRemoved(auth, id, false, body.reason, requestMeta(req));
  }

  @Post(':id/reports')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: throttle('communityReport') })
  async report(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(reportPostRequestSchema))
    body: { category: ReportCategory; description?: string },
  ): Promise<{ received: true }> {
    await this.moderation.report(auth, id, body);
    return { received: true };
  }
}

/** `/api/v1/channel-reports/:id` — resolving reports (channel moderators). */
@Controller('channel-reports')
@Throttle({ default: throttle('moderation') })
export class ChannelReportsController {
  constructor(private readonly moderation: ChannelModerationService) {}

  @Post(':id/resolve')
  @HttpCode(HttpStatus.NO_CONTENT)
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(resolveReportRequestSchema))
    body: { outcome: 'RESOLVED' | 'DISMISSED'; resolution?: string; removePost?: boolean },
    @Req() req: Request,
  ): Promise<void> {
    return this.moderation.resolveReport(auth, id, body, requestMeta(req));
  }
}

const MEDIA_UPLOAD_MAX_BYTES = Math.max(...Object.values(ATTACHMENT_MAX_BYTES));

/** `/api/v1/channel-attachments` — server-readable channel media. */
@Controller('channel-attachments')
export class ChannelMediaController {
  constructor(private readonly media: ChannelMediaService) {}

  /** `multipart/form-data`: fields `channelId`, `kind`, `name`, `mime` and one `file`. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('attachmentUpload') })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 512 },
    }),
  )
  upload(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(channelMediaFieldsSchema))
    fields: { channelId: string; kind: AttachmentKind; name: string; mime: string },
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ChannelAttachmentView> {
    if (!file) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_MEDIA',
        'Attach the file in the "file" field',
      );
    }
    return this.media.upload(auth, fields, file.buffer);
  }

  /**
   * Re-encoded images are served inline as WebP; every other file only as a
   * download with a neutral type, so uploaded HTML/SVG can never execute.
   */
  @Get(':id')
  @Throttle({ default: throttle('sync') })
  @Header('Cache-Control', 'private, max-age=3600')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { data, image } = await this.media.download(auth.userId, id);
    res.setHeader('Content-Type', image ? 'image/webp' : 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      image ? 'inline' : 'attachment; filename="attachment.bin"',
    );
    res.setHeader('Content-Length', data.length);
    return new StreamableFile(data);
  }
}
