import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffRolesGuard } from '../auth/staff-roles.js';
import { ChannelAccessService } from '../channels/channel-access.service.js';
import { ChannelMediaService } from '../channels/channel-media.service.js';
import { ChannelModerationService } from '../channels/channel-moderation.service.js';
import { ChannelPostsService } from '../channels/channel-posts.service.js';
import {
  ChannelMediaController,
  ChannelPostsController,
  ChannelReportsController,
  ChannelsController,
} from '../channels/channels.controller.js';
import { ChannelsService } from '../channels/channels.service.js';
import { ConversationAccessModule } from '../conversations/conversation-access.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ConversationReportsService } from '../groups/conversation-reports.service.js';
import { GroupMembershipService } from '../groups/group-membership.service.js';
import {
  AdminConversationReportsController,
  ConversationSettingsController,
  GroupsController,
  InvitationsController,
} from '../groups/groups.controller.js';
import { GroupsService } from '../groups/groups.service.js';
import { InvitationsService } from '../groups/invitations.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import { InviteLinksController } from './invite-links.controller.js';
import { InviteLinksService } from './invite-links.service.js';

/**
 * Groups, private encrypted channels and community channels (Phase 4). One
 * module because invitation links serve both and both share the permission
 * matrix in `community-permissions.ts`.
 */
@Module({
  imports: [
    AuditModule,
    ConversationAccessModule,
    ConversationsModule,
    NotificationsModule,
    RelationshipsModule,
  ],
  controllers: [
    GroupsController,
    InvitationsController,
    ConversationSettingsController,
    AdminConversationReportsController,
    ChannelsController,
    ChannelPostsController,
    ChannelReportsController,
    ChannelMediaController,
    InviteLinksController,
  ],
  providers: [
    GroupMembershipService,
    GroupsService,
    InvitationsService,
    ConversationReportsService,
    ChannelAccessService,
    ChannelsService,
    ChannelPostsService,
    ChannelModerationService,
    ChannelMediaService,
    InviteLinksService,
    StaffRolesGuard,
  ],
})
export class CommunityModule {}
