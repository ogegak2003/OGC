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
  ConversationReportView,
  ConversationView,
  CreatedInviteLink,
  GroupMemberView,
  InviteLinkView,
  InviteResult,
  NotificationPreferences,
  OgcId,
  Page,
  ReceivedInvitationView,
  SentInvitationView,
} from '@ogc/types';
import {
  conversationReportRequestSchema,
  createGroupRequestSchema,
  createInviteLinkRequestSchema,
  inviteMembersRequestSchema,
  notificationPreferencesSchema,
  ogcIdInputSchema,
  roleChangeRequestSchema,
  transferOwnershipRequestSchema,
  updateGroupRequestSchema,
  uuidSchema,
} from '@ogc/validation';
import type { Request, Response } from 'express';
import { ApiException } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { RequireStaffRole } from '../auth/staff-roles.js';
import { InviteLinksService } from '../community/invite-links.service.js';
import { AVATAR_MAX_BYTES, invalidMedia } from '../profiles/avatar-image.js';
import { type AdminReportQuery, adminReportQuerySchema } from '../reports/admin-report-query.js';
import { ObjectStorage } from '../storage/object-storage.js';
import {
  type ConversationReportInput,
  ConversationReportsService,
} from './conversation-reports.service.js';
import { type CreateGroupInput, GroupsService, type UpdateGroupInput } from './groups.service.js';
import { InvitationsService } from './invitations.service.js';

const idParam = new ZodValidationPipe(uuidSchema);
const ogcIdParam = new ZodValidationPipe(ogcIdInputSchema);

const avatarUpload = FileInterceptor('avatar', {
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 },
});

/**
 * `/api/v1/groups` — private groups and private encrypted channels. Every
 * route requires the caller to be a member (others get 404) and checks the
 * permission matrix server-side.
 */
@Controller('groups')
@Throttle({ default: throttle('communityManage') })
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly invitations: InvitationsService,
    private readonly links: InviteLinksService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('communityCreate') })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createGroupRequestSchema)) body: CreateGroupInput,
    @Req() req: Request,
  ): Promise<{ conversation: ConversationView; invited: OgcId[] }> {
    return this.groups.create(auth, body, requestMeta(req));
  }

  @Get(':id/members')
  @Throttle({ default: throttle('sync') })
  members(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<GroupMemberView[]> {
    return this.groups.members(auth.userId, id);
  }

  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateGroupRequestSchema)) body: UpdateGroupInput,
  ): Promise<ConversationView> {
    return this.groups.update(auth, id, body);
  }

  /** `multipart/form-data` with a single `avatar` image; re-encoded server-side. */
  @Post(':id/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseInterceptors(avatarUpload)
  async setAvatar(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<void> {
    if (!file) throw invalidMedia('Attach an image in the "avatar" field');
    await this.groups.setAvatar(auth, id, file.buffer);
  }

  @Delete(':id/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAvatar(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.groups.removeAvatar(auth, id);
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
    const data = await this.groups.avatar(auth.userId, id);
    res.setHeader('Content-Length', data.length);
    return new StreamableFile(data);
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
    return this.groups.changeRole(auth, id, ogcId, body.role);
  }

  @Delete(':id/members/:ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('ogcId', ogcIdParam) ogcId: OgcId,
    @Req() req: Request,
  ): Promise<void> {
    return this.groups.removeMember(auth, id, ogcId, requestMeta(req));
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.groups.leave(auth, id);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.NO_CONTENT)
  transfer(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(transferOwnershipRequestSchema)) body: { ogcId: OgcId },
    @Req() req: Request,
  ): Promise<void> {
    return this.groups.transferOwnership(auth, id, body.ogcId, requestMeta(req));
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.groups.setArchived(auth, id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.NO_CONTENT)
  unarchive(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.groups.setArchived(auth, id, false);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.groups.delete(auth, id, requestMeta(req));
  }

  @Post(':id/invitations')
  @Throttle({ default: throttle('invite') })
  invite(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(inviteMembersRequestSchema)) body: { ogcIds: OgcId[] },
  ): Promise<InviteResult> {
    return this.invitations.invite(auth, id, body.ogcIds);
  }

  @Get(':id/invitations')
  sentInvitations(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<SentInvitationView[]> {
    return this.invitations.sent(auth.userId, id);
  }

  /** The token is returned once, in this response only. */
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
    return this.links.create(auth, { conversationId: id }, body, requestMeta(req));
  }

  @Get(':id/invite-links')
  listLinks(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<InviteLinkView[]> {
    return this.links.list(auth, { conversationId: id });
  }
}

/** `/api/v1/invitations` — personal invitations received by the caller. */
@Controller('invitations')
@Throttle({ default: throttle('communityManage') })
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly storage: ObjectStorage,
  ) {}

  @Get()
  @Throttle({ default: throttle('sync') })
  received(@CurrentAuth() auth: AuthContext): Promise<ReceivedInvitationView[]> {
    return this.invitations.received(auth.userId);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<{ conversationId: string }> {
    return this.invitations.accept(auth, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  decline(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.invitations.decline(auth.userId, id);
  }

  /** Revoke a pending invitation (the inviter, the owner or an administrator). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<void> {
    return this.invitations.revoke(auth, id);
  }

  /** The group photo, for the invitee of a pending invitation. */
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
    const key = await this.invitations.invitationAvatar(auth.userId, id);
    const data = await this.storage.get(key);
    if (!data) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No photo');
    res.setHeader('Content-Length', data.length);
    return new StreamableFile(data);
  }
}

/** Per-conversation settings and reports, for every conversation type. */
@Controller('conversations')
@Throttle({ default: throttle('communityManage') })
export class ConversationSettingsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly reports: ConversationReportsService,
  ) {}

  @Get(':id/notifications')
  preferences(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<NotificationPreferences> {
    return this.groups.preferences(auth.userId, id);
  }

  @Put(':id/notifications')
  setPreferences(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(notificationPreferencesSchema))
    body: { level?: 'ALL' | 'MENTIONS' | 'NONE'; mutedUntil?: string | null },
  ): Promise<NotificationPreferences> {
    return this.groups.setPreferences(auth, id, body);
  }

  /**
   * Report a conversation or message. `disclosedText` is the decrypted text the
   * reporter explicitly chose to share — the only way OGC staff ever see it.
   */
  @Post(':id/reports')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: throttle('communityReport') })
  async report(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(conversationReportRequestSchema)) body: ConversationReportInput,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    await this.reports.report(auth, id, body, requestMeta(req));
    return { received: true };
  }
}

/** Staff queue of reports from encrypted conversations (disclosed text only). */
@Controller('admin/conversation-reports')
@RequireStaffRole('MODERATOR', 'ADMIN')
export class AdminConversationReportsController {
  constructor(private readonly reports: ConversationReportsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(adminReportQuerySchema)) query: AdminReportQuery,
  ): Promise<Page<ConversationReportView>> {
    return this.reports.list(query.status, query);
  }
}
