import { HttpStatus, Injectable } from '@nestjs/common';
import type { CreatedInviteLink, InviteLinkView, InvitePreview, JoinResult } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ChannelAccessService } from '../channels/channel-access.service.js';
import { channelAvatarUrl } from '../channels/channel-views.js';
import { ChannelsService } from '../channels/channels.service.js';
import {
  ConversationAccessService,
  conversationNotFound,
} from '../conversations/conversation-access.service.js';
import { GroupMembershipService } from '../groups/group-membership.service.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { canManageInviteLinks } from './community-permissions.js';
import { hashInviteToken, newInviteToken } from './invite-tokens.js';

const HOUR = 60 * 60_000;
const LINKS_LIST_MAX = 50;

/**
 * Every reason a token cannot be used — unknown, revoked, expired, used up —
 * gives the same answer, so links cannot be probed.
 */
export const invitationInvalid = (): ApiException =>
  new ApiException(
    HttpStatus.NOT_FOUND,
    'INVITATION_INVALID',
    'This invitation link is invalid or has expired',
  );

export type LinkTarget = { conversationId: string } | { channelId: string };

const LINK_SELECT = {
  id: true,
  createdAt: true,
  expiresAt: true,
  maxUses: true,
  useCount: true,
  revokedAt: true,
  createdBy: {
    select: {
      id: true,
      ogcId: true,
      profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
    },
  },
} as const satisfies Prisma.InviteLinkSelect;

/**
 * Invitation links and QR codes (ADR-034). A link carries a 256-bit random
 * token; only its SHA-256 is stored. Links expire, can be limited in uses and
 * revoked, and never bypass a target's rules: group capacity and archive
 * state, channel bans and approval policy all still apply. A link is a
 * capability to *ask to join* — it contains no keys, IDs or content.
 */
@Injectable()
export class InviteLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationAccessService,
    private readonly channelAccess: ChannelAccessService,
    private readonly channels: ChannelsService,
    private readonly groupMembership: GroupMembershipService,
    private readonly relationships: RelationshipService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  /** Owners and administrators of the target only. */
  private async requireManager(userId: string, target: LinkTarget): Promise<void> {
    if ('conversationId' in target) {
      const access = await this.conversations.require(userId, target.conversationId);
      if (access.type === 'DIRECT' || !access.group) throw conversationNotFound();
      this.conversations.assertWritable(access);
      if (!canManageInviteLinks(access.role)) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          'FORBIDDEN',
          'Only administrators can manage links',
        );
      }
      return;
    }
    const access = await this.channelAccess.requireMember(userId, target.channelId);
    this.channelAccess.assertWritable(access);
    if (!access.role || !canManageInviteLinks(access.role)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Only administrators can manage links',
      );
    }
  }

  async create(
    auth: AuthContext,
    target: LinkTarget,
    input: { expiresInHours: number; maxUses?: number | undefined },
    meta: RequestMeta,
  ): Promise<CreatedInviteLink> {
    await this.requireManager(auth.userId, target);
    const { token, hash } = newInviteToken();
    const link = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inviteLink.create({
        data: {
          tokenHash: hash,
          ...target,
          createdById: auth.userId,
          expiresAt: new Date(Date.now() + input.expiresInHours * HOUR),
          maxUses: input.maxUses ?? null,
        },
        select: LINK_SELECT,
      });
      await this.audit.record(
        {
          type: 'INVITE_LINK_CREATED',
          userId: auth.userId,
          sessionId: auth.sessionId,
          meta,
          details: { linkId: created.id, ...target },
        },
        tx,
      );
      return created;
    });
    this.metrics.communityEvents.inc({ event: 'invite_link_created' });
    const [view] = await this.toViews(auth.userId, [link]);
    if (!view) throw new Error('Invite link view missing');
    return { ...view, token };
  }

  async list(auth: AuthContext, target: LinkTarget): Promise<InviteLinkView[]> {
    await this.requireManager(auth.userId, target);
    const rows = await this.prisma.inviteLink.findMany({
      where: target,
      orderBy: { id: 'desc' },
      take: LINKS_LIST_MAX,
      select: LINK_SELECT,
    });
    return this.toViews(auth.userId, rows);
  }

  private async toViews(
    viewerId: string,
    rows: Prisma.InviteLinkGetPayload<{ select: typeof LINK_SELECT }>[],
  ): Promise<InviteLinkView[]> {
    const creators = rows.flatMap((r) => (r.createdBy ? [r.createdBy] : []));
    const summaries = await this.relationships.summariesFor(viewerId, creators);
    return rows.map((r) => ({
      id: r.id,
      createdBy: r.createdBy ? (summaries.get(r.createdBy.id) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      maxUses: r.maxUses,
      useCount: r.useCount,
      revokedAt: r.revokedAt?.toISOString() ?? null,
    }));
  }

  async revoke(auth: AuthContext, linkId: string, meta: RequestMeta): Promise<void> {
    const link = await this.prisma.inviteLink.findUnique({
      where: { id: linkId },
      select: { id: true, conversationId: true, channelId: true, revokedAt: true },
    });
    if (!link) throw invitationInvalid();
    const target: LinkTarget = link.conversationId
      ? { conversationId: link.conversationId }
      : { channelId: link.channelId ?? '' };
    // Non-managers get the same answer as for an unknown link.
    await this.requireManager(auth.userId, target).catch(() => {
      throw invitationInvalid();
    });
    if (link.revokedAt) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.inviteLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
      await this.audit.record(
        {
          type: 'INVITE_LINK_REVOKED',
          userId: auth.userId,
          sessionId: auth.sessionId,
          meta,
          details: { linkId, ...target },
        },
        tx,
      );
    });
  }

  private async resolve(token: string) {
    const link = await this.prisma.inviteLink.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true,
        conversationId: true,
        channelId: true,
        expiresAt: true,
        maxUses: true,
        useCount: true,
        revokedAt: true,
      },
    });
    if (
      !link ||
      link.revokedAt ||
      (link.expiresAt && link.expiresAt <= new Date()) ||
      (link.maxUses !== null && link.useCount >= link.maxUses)
    ) {
      this.metrics.communityEvents.inc({ event: 'invite_link_invalid' });
      throw invitationInvalid();
    }
    return link;
  }

  /** What the link leads to. Shows only what a prospective member needs to decide. */
  async preview(viewerId: string, token: string): Promise<InvitePreview> {
    const link = await this.resolve(token);
    if (link.conversationId) {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: link.conversationId },
        select: {
          type: true,
          groupProfile: { select: { name: true, description: true, archivedAt: true } },
          participants: { select: { userId: true } },
        },
      });
      if (!conversation?.groupProfile || conversation.groupProfile.archivedAt)
        throw invitationInvalid();
      return {
        target: conversation.type === 'CHANNEL' ? 'CHANNEL' : 'GROUP',
        id: link.conversationId,
        name: conversation.groupProfile.name,
        description: conversation.groupProfile.description,
        // Group photos are members-only; previews show initials instead.
        avatarUrl: null,
        memberCount: conversation.participants.length,
        alreadyMember: conversation.participants.some((p) => p.userId === viewerId),
        requiresApproval: false,
        endToEndEncrypted: true,
      };
    }
    const access = await this.channelAccess.load(viewerId, link.channelId ?? '');
    if (!access || access.channel.archivedAt || access.membership?.status === 'BANNED') {
      throw invitationInvalid();
    }
    return {
      target: 'COMMUNITY_CHANNEL',
      id: access.channel.id,
      name: access.channel.name,
      description: access.channel.description,
      avatarUrl:
        access.channel.visibility === 'PUBLIC'
          ? channelAvatarUrl(access.channel.id, access.channel.avatarKey)
          : null,
      memberCount: access.channel.memberCount,
      alreadyMember: access.active,
      requiresApproval: access.channel.joinPolicy === 'APPROVAL',
      endToEndEncrypted: false,
    };
  }

  /**
   * Joins through a link. The use is consumed atomically with the join (a
   * conditional increment), so a link limited to N uses admits at most N
   * people even under concurrent joins. Existing members do not consume uses.
   */
  async join(auth: AuthContext, token: string): Promise<JoinResult> {
    const link = await this.resolve(token);
    const consume = async (tx: Prisma.TransactionClient): Promise<void> => {
      const consumed = await tx.inviteLink.updateMany({
        where: {
          id: link.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          ...(link.maxUses !== null ? { useCount: { lt: link.maxUses } } : {}),
        },
        data: { useCount: { increment: 1 } },
      });
      if (consumed.count !== 1) throw invitationInvalid();
    };
    if (link.conversationId) {
      const type = await this.prisma.conversation.findUnique({
        where: { id: link.conversationId },
        select: { type: true },
      });
      if (!type) throw invitationInvalid();
      await this.groupMembership.addMember(link.conversationId, auth.userId, 'link', consume);
      this.metrics.communityEvents.inc({ event: 'invite_link_join' });
      return {
        target: type.type === 'CHANNEL' ? 'CHANNEL' : 'GROUP',
        id: link.conversationId,
        status: 'JOINED',
      };
    }
    const channelId = link.channelId ?? '';
    const status = await this.channels.addMember(auth.userId, channelId, {
      viaLink: true,
      extra: consume,
    });
    this.metrics.communityEvents.inc({ event: 'invite_link_join' });
    return { target: 'COMMUNITY_CHANNEL', id: channelId, status };
  }
}
