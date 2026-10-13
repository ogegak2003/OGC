import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ConversationView, GroupMemberView, NotificationPreferences, OgcId } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { blankToNull } from '../../common/text.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { CommunityRole, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  canArchiveOrDelete,
  canActOnMember,
  canAssignRole,
  canChangePolicies,
  canEditDetails,
  canTransferOwnership,
} from '../community/community-permissions.js';
import {
  ConversationAccessService,
  type ParticipantAccess,
  conversationNotFound,
} from '../conversations/conversation-access.service.js';
import {
  lockConversation,
  recordConversationEvent,
} from '../conversations/conversation-version.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { CommunityNotificationsService } from '../notifications/community-notifications.service.js';
import { processAvatar } from '../profiles/avatar-image.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { GroupMembershipService } from './group-membership.service.js';
import { InvitationsService } from './invitations.service.js';

const forbidden = (message = 'You do not have permission to do that'): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);

const memberNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Member not found');

export interface CreateGroupInput {
  kind: 'GROUP' | 'CHANNEL';
  name: string;
  description?: string | undefined;
  invite?: OgcId[] | undefined;
}

export interface UpdateGroupInput {
  name?: string | undefined;
  description?: string | null | undefined;
  postPolicy?: 'ALL_MEMBERS' | 'MODERATORS' | 'ADMINS' | undefined;
  invitePolicy?: 'ALL_MEMBERS' | 'ADMINS' | undefined;
}

/**
 * Private groups and private encrypted channels (ADR-031): details, roles and
 * lifecycle. Authorization follows docs/architecture/community-permissions.md
 * through `community-permissions.ts`; every check runs on the server against
 * the stored role, never a client claim. Names, descriptions, photos and
 * membership are server-visible metadata; messages stay end-to-end encrypted.
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly conversations: ConversationsService,
    private readonly membership: GroupMembershipService,
    private readonly invitations: InvitationsService,
    private readonly relationships: RelationshipService,
    private readonly notifications: CommunityNotificationsService,
    private readonly realtime: RealtimePublisher,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
  ) {}

  /** Loads the caller's access and requires a group or encrypted channel. */
  async requireGroup(userId: string, conversationId: string): Promise<ParticipantAccess> {
    const access = await this.access.require(userId, conversationId);
    if (access.type === 'DIRECT' || !access.group) throw conversationNotFound();
    return access;
  }

  async create(
    auth: AuthContext,
    input: CreateGroupInput,
    meta: RequestMeta,
  ): Promise<{ conversation: ConversationView; invited: OgcId[] }> {
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.create({
        data: {
          id,
          type: input.kind,
          createdById: auth.userId,
          participants: { create: [{ userId: auth.userId, role: 'OWNER' }] },
          groupProfile: {
            create: {
              name: input.name,
              description: blankToNull(input.description),
              // Encrypted channels are broadcast-style: only admins post by default.
              postPolicy: input.kind === 'CHANNEL' ? 'ADMINS' : 'ALL_MEMBERS',
            },
          },
        },
      });
      await recordConversationEvent(tx, id, {
        type: 'CREATED',
        actorId: auth.userId,
        detail: { kind: input.kind },
      });
      await this.audit.record(
        {
          type: 'GROUP_CREATED',
          userId: auth.userId,
          sessionId: auth.sessionId,
          meta,
          details: { conversationId: id, kind: input.kind },
        },
        tx,
      );
    });
    const invited =
      input.invite && input.invite.length > 0
        ? (await this.invitations.invite(auth, id, input.invite)).invited
        : [];
    const conversation = await this.conversations.view(auth.userId, id);
    this.realtime.toUsers([auth.userId], 'group.created', { conversation });
    return { conversation, invited };
  }

  async members(viewerId: string, conversationId: string): Promise<GroupMemberView[]> {
    await this.requireGroup(viewerId, conversationId);
    const rows = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      select: {
        role: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            ogcId: true,
            profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
          },
        },
      },
    });
    const summaries = await this.relationships.summariesFor(
      viewerId,
      rows.map((r) => r.user),
    );
    const order: Record<CommunityRole, number> = { OWNER: 0, ADMIN: 1, MODERATOR: 2, MEMBER: 3 };
    return rows
      .map((r) => ({
        profile: summaries.get(r.user.id) ?? this.relationships.summary(r.user, false),
        role: r.role,
        joinedAt: r.joinedAt.toISOString(),
      }))
      .sort((a, b) => order[a.role] - order[b.role]);
  }

  async update(
    auth: AuthContext,
    conversationId: string,
    input: UpdateGroupInput,
  ): Promise<ConversationView> {
    const access = await this.requireGroup(auth.userId, conversationId);
    this.access.assertWritable(access);
    const detailsChange = input.name !== undefined || input.description !== undefined;
    const policyChange = input.postPolicy !== undefined || input.invitePolicy !== undefined;
    if (detailsChange && !canEditDetails(access.role)) throw forbidden();
    if (policyChange && !canChangePolicies(access.role)) throw forbidden();

    const fields = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    const version = await this.prisma.$transaction(async (tx) => {
      await tx.groupProfile.update({
        where: { conversationId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: blankToNull(input.description) }
            : {}),
          ...(input.postPolicy !== undefined ? { postPolicy: input.postPolicy } : {}),
          ...(input.invitePolicy !== undefined ? { invitePolicy: input.invitePolicy } : {}),
        },
      });
      return recordConversationEvent(tx, conversationId, {
        type: 'DETAILS_UPDATED',
        actorId: auth.userId,
        detail: { fields },
      });
    });
    await this.announceUpdate(access, version, auth.userId);
    return this.conversations.view(auth.userId, conversationId);
  }

  /** Tells members about a details change: realtime for all, in-app per their preferences. */
  private async announceUpdate(
    access: ParticipantAccess,
    version: bigint,
    actorId: string,
  ): Promise<void> {
    const memberIds = access.members.map((m) => m.userId);
    this.realtime.toUsers(memberIds, 'group.updated', {
      conversationId: access.conversationId,
      version: Number(version),
    });
    const [profile, wanting] = await Promise.all([
      this.prisma.groupProfile.findUnique({
        where: { conversationId: access.conversationId },
        select: { name: true },
      }),
      this.prisma.conversationParticipant.findMany({
        where: {
          conversationId: access.conversationId,
          userId: { not: actorId },
          notificationLevel: 'ALL',
          OR: [{ mutedUntil: null }, { mutedUntil: { lt: new Date() } }],
        },
        select: { userId: true },
      }),
    ]);
    if (!profile) return;
    await this.notifications.notify(
      wanting.map((w) => ({
        userId: w.userId,
        type: 'GROUP_DETAILS_CHANGED' as const,
        dedupeKey: `group-details:${access.conversationId}:${String(version)}`,
        data: { conversationId: access.conversationId, groupName: profile.name },
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Photo
  // -------------------------------------------------------------------------

  async setAvatar(auth: AuthContext, conversationId: string, upload: Buffer): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    this.access.assertWritable(access);
    if (!canEditDetails(access.role)) throw forbidden();
    if (!this.storage.enabled) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'MEDIA_UNAVAILABLE',
        'Photo uploads are not available right now',
      );
    }
    const processed = await processAvatar(upload);
    const key = `avatars/${randomUUID()}.webp`;
    await this.storage.put(key, processed, 'image/webp');
    let previous: string | null;
    let version: bigint;
    try {
      ({ previous, version } = await this.prisma.$transaction(async (tx) => {
        const current = await tx.groupProfile.findUniqueOrThrow({
          where: { conversationId },
          select: { avatarKey: true },
        });
        await tx.groupProfile.update({ where: { conversationId }, data: { avatarKey: key } });
        const v = await recordConversationEvent(tx, conversationId, {
          type: 'DETAILS_UPDATED',
          actorId: auth.userId,
          detail: { fields: ['avatar'] },
        });
        return { previous: current.avatarKey, version: v };
      }));
    } catch (error) {
      await this.storage.delete(key);
      throw error;
    }
    if (previous) await this.removeObject(previous);
    await this.announceUpdate(access, version, auth.userId);
  }

  async removeAvatar(auth: AuthContext, conversationId: string): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    this.access.assertWritable(access);
    if (!canEditDetails(access.role)) throw forbidden();
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.groupProfile.findUniqueOrThrow({
        where: { conversationId },
        select: { avatarKey: true },
      });
      if (!current.avatarKey) return undefined;
      await tx.groupProfile.update({ where: { conversationId }, data: { avatarKey: null } });
      const version = await recordConversationEvent(tx, conversationId, {
        type: 'DETAILS_UPDATED',
        actorId: auth.userId,
        detail: { fields: ['avatar'] },
      });
      return { key: current.avatarKey, version };
    });
    if (!result) return;
    await this.removeObject(result.key);
    await this.announceUpdate(access, result.version, auth.userId);
  }

  /** The photo, for members only (same 404 otherwise). */
  async avatar(viewerId: string, conversationId: string): Promise<Buffer> {
    await this.requireGroup(viewerId, conversationId);
    const profile = await this.prisma.groupProfile.findUnique({
      where: { conversationId },
      select: { avatarKey: true },
    });
    const data = profile?.avatarKey ? await this.storage.get(profile.avatarKey) : undefined;
    if (!data) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No photo');
    return data;
  }

  private async removeObject(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn({ err: error }, 'Old group photo cleanup failed');
    }
  }

  // -------------------------------------------------------------------------
  // Roles and membership
  // -------------------------------------------------------------------------

  private target(access: ParticipantAccess, ogcId: OgcId) {
    const member = access.members.find((m) => m.ogcId === ogcId);
    if (!member) throw memberNotFound();
    return member;
  }

  async changeRole(
    auth: AuthContext,
    conversationId: string,
    ogcId: OgcId,
    role: 'ADMIN' | 'MODERATOR' | 'MEMBER',
  ): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    this.access.assertWritable(access);
    const target = this.target(access, ogcId);
    const kind = access.type === 'GROUP' ? 'GROUP' : 'CHANNEL';
    if (!canAssignRole(access.role, target.role, role, kind, target.userId === auth.userId)) {
      throw forbidden('You cannot assign that role');
    }
    const version = await this.membership.setRole(conversationId, auth.userId, target.userId, role);
    if (version === undefined) return;
    this.realtime.toUsers(
      access.members.map((m) => m.userId),
      'group.role_changed',
      { conversationId, version: Number(version), ogcId, role },
    );
    const profile = await this.prisma.groupProfile.findUnique({
      where: { conversationId },
      select: { name: true },
    });
    await this.notifications.notify([
      {
        userId: target.userId,
        type: 'GROUP_ROLE_CHANGED',
        dedupeKey: `group-role:${conversationId}:${String(version)}`,
        data: { conversationId, groupName: profile?.name ?? '', role },
      },
    ]);
  }

  /** The owner hands ownership to another member and becomes an administrator. */
  async transferOwnership(
    auth: AuthContext,
    conversationId: string,
    ogcId: OgcId,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    if (!canTransferOwnership(access.role)) throw forbidden('Only the owner can do that');
    const target = this.target(access, ogcId);
    if (target.userId === auth.userId) throw forbidden('You already own this group');
    if (target.status !== 'ACTIVE') throw forbidden('That account is not available');
    const version = await this.prisma.$transaction(async (tx) => {
      if (!(await lockConversation(tx, conversationId))) throw conversationNotFound();
      // Demote first: at most one owner may exist at any moment (unique index).
      const demoted = await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: auth.userId, role: 'OWNER' },
        data: { role: 'ADMIN' },
      });
      const promoted = await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: target.userId },
        data: { role: 'OWNER' },
      });
      if (demoted.count !== 1 || promoted.count !== 1) {
        throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'Membership changed; try again');
      }
      await this.audit.record(
        {
          type: 'GROUP_OWNERSHIP_TRANSFERRED',
          userId: auth.userId,
          sessionId: auth.sessionId,
          meta,
          details: { conversationId },
        },
        tx,
      );
      return recordConversationEvent(tx, conversationId, {
        type: 'OWNERSHIP_TRANSFERRED',
        actorId: auth.userId,
        subjectId: target.userId,
      });
    });
    const memberIds = access.members.map((m) => m.userId);
    this.realtime.toUsers(memberIds, 'group.role_changed', {
      conversationId,
      version: Number(version),
      ogcId,
      role: 'OWNER',
    });
    this.realtime.toUsers(memberIds, 'group.role_changed', {
      conversationId,
      version: Number(version),
      ogcId: auth.ogcId,
      role: 'ADMIN',
    });
    await this.notifications.notify([
      {
        userId: target.userId,
        type: 'GROUP_ROLE_CHANGED',
        dedupeKey: `group-role:${conversationId}:${String(version)}`,
        data: { conversationId, role: 'OWNER' },
      },
    ]);
  }

  async removeMember(
    auth: AuthContext,
    conversationId: string,
    ogcId: OgcId,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    const target = this.target(access, ogcId);
    if (target.userId === auth.userId) throw forbidden('Use “Leave” to leave the group');
    const kind = access.type === 'GROUP' ? 'GROUP' : 'CHANNEL';
    if (!canActOnMember(access.role, target.role, kind)) {
      throw forbidden('You cannot remove this member');
    }
    const profile = await this.prisma.groupProfile.findUnique({
      where: { conversationId },
      select: { name: true },
    });
    const { removed } = await this.membership.removeMember(conversationId, target.userId, {
      type: 'MEMBER_REMOVED',
      actorId: auth.userId,
    });
    if (!removed) return;
    await this.audit.record({
      type: 'GROUP_MEMBER_REMOVED',
      userId: auth.userId,
      sessionId: auth.sessionId,
      meta,
      details: { conversationId },
    });
    await this.notifications.notify([
      {
        userId: target.userId,
        type: 'GROUP_MEMBER_REMOVED',
        dedupeKey: `group-removed:${conversationId}:${randomUUID()}`,
        data: { groupName: profile?.name ?? '' },
      },
    ]);
  }

  /**
   * Leaves the group. The owner must transfer ownership first unless they are
   * the last member — then the group is deleted.
   */
  async leave(auth: AuthContext, conversationId: string): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    if (access.role === 'OWNER' && access.members.length > 1) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'Transfer ownership to another member before leaving',
      );
    }
    await this.membership.removeMember(conversationId, auth.userId, {
      type: 'MEMBER_LEFT',
      actorId: auth.userId,
    });
  }

  /** Archived groups are read-only for everyone; only the owner can archive or restore. */
  async setArchived(auth: AuthContext, conversationId: string, archived: boolean): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    if (!canArchiveOrDelete(access.role)) throw forbidden('Only the owner can do that');
    if (access.group?.archived === archived) return;
    const version = await this.prisma.$transaction(async (tx) => {
      await tx.groupProfile.update({
        where: { conversationId },
        data: { archivedAt: archived ? new Date() : null },
      });
      return recordConversationEvent(tx, conversationId, {
        type: archived ? 'ARCHIVED' : 'UNARCHIVED',
        actorId: auth.userId,
      });
    });
    this.realtime.toUsers(
      access.members.map((m) => m.userId),
      'group.updated',
      { conversationId, version: Number(version) },
    );
  }

  /**
   * Deletes the group for everyone: messages, encryption state, attachments and
   * the photo are removed from the server and members' devices erase it.
   * Copies already exported or backed up by members cannot be reached.
   */
  async delete(auth: AuthContext, conversationId: string, meta: RequestMeta): Promise<void> {
    const access = await this.requireGroup(auth.userId, conversationId);
    if (!canArchiveOrDelete(access.role)) throw forbidden('Only the owner can do that');
    await this.audit.record({
      type: 'GROUP_DELETED',
      userId: auth.userId,
      sessionId: auth.sessionId,
      meta,
      details: { conversationId, members: access.members.length },
    });
    await this.membership.deleteConversation(
      conversationId,
      access.members.map((m) => m.userId),
    );
  }

  // -------------------------------------------------------------------------
  // Preferences (any conversation)
  // -------------------------------------------------------------------------

  async setPreferences(
    auth: AuthContext,
    conversationId: string,
    input: { level?: 'ALL' | 'MENTIONS' | 'NONE' | undefined; mutedUntil?: string | null },
  ): Promise<NotificationPreferences> {
    await this.access.require(auth.userId, conversationId);
    const data: Prisma.ConversationParticipantUpdateInput = {
      ...(input.level !== undefined ? { notificationLevel: input.level } : {}),
      ...(input.mutedUntil !== undefined
        ? { mutedUntil: input.mutedUntil === null ? null : new Date(input.mutedUntil) }
        : {}),
    };
    const row = await this.prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: auth.userId } },
      data,
      select: { notificationLevel: true, mutedUntil: true },
    });
    return { level: row.notificationLevel, mutedUntil: row.mutedUntil?.toISOString() ?? null };
  }

  async preferences(viewerId: string, conversationId: string): Promise<NotificationPreferences> {
    await this.access.require(viewerId, conversationId);
    const row = await this.prisma.conversationParticipant.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId: viewerId } },
      select: { notificationLevel: true, mutedUntil: true },
    });
    return { level: row.notificationLevel, mutedUntil: row.mutedUntil?.toISOString() ?? null };
  }
}
