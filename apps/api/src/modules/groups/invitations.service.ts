import {
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { InviteResult, OgcId, ReceivedInvitationView, SentInvitationView } from '@ogc/types';
import { GROUP_MEMBER_LIMIT, INVITATION_TTL_DAYS } from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import type { AuthContext } from '../auth/auth-context.js';
import { canInvite } from '../community/community-permissions.js';
import {
  ConversationAccessService,
  conversationNotFound,
} from '../conversations/conversation-access.service.js';
import { avatarVersion } from '../conversations/conversations.service.js';
import { CommunityNotificationsService } from '../notifications/community-notifications.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { GroupMembershipService, memberLimitReached } from './group-membership.service.js';

const DAY = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const SENT_LIST_MAX = 100;

const invitationNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Invitation not found');

const INVITATION_SELECT = {
  id: true,
  conversationId: true,
  inviterId: true,
  inviteeId: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  conversation: {
    select: {
      type: true,
      groupProfile: { select: { name: true, avatarKey: true } },
      _count: { select: { participants: true } },
    },
  },
  inviter: {
    select: {
      id: true,
      ogcId: true,
      profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
    },
  },
} as const;

/**
 * Personal invitations to groups and encrypted channels (ADR-034). People can
 * invite their contacts only; an invitation never adds anyone by itself — the
 * invitee must accept. Invitations expire after 14 days. Outcomes that would
 * reveal a block or privacy setting are skipped silently.
 */
@Injectable()
export class InvitationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvitationsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly membership: GroupMembershipService,
    private readonly relationships: RelationshipService,
    private readonly notifications: CommunityNotificationsService,
    private readonly realtime: RealtimePublisher,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.expire().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Invitation expiry sweep failed');
      });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async invite(auth: AuthContext, conversationId: string, ogcIds: OgcId[]): Promise<InviteResult> {
    const access = await this.access.require(auth.userId, conversationId);
    if (access.type === 'DIRECT' || !access.group) throw conversationNotFound();
    this.access.assertWritable(access);
    if (!canInvite(access.role, access.group.invitePolicy)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Only administrators can invite people',
      );
    }
    if (access.members.length >= GROUP_MEMBER_LIMIT) throw memberLimitReached();

    const memberIds = new Set(access.members.map((m) => m.userId));
    const candidates = await this.prisma.user.findMany({
      where: {
        ogcId: { in: [...new Set(ogcIds)] },
        status: 'ACTIVE',
        // Contacts of the inviter only, with no block in either direction.
        contactOf: { some: { ownerId: auth.userId } },
        blocksMade: { none: { blockedId: auth.userId } },
        blocksReceived: { none: { blockerId: auth.userId } },
      },
      select: { id: true, ogcId: true },
    });
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * DAY);
    const invited: OgcId[] = [];
    for (const candidate of candidates) {
      if (memberIds.has(candidate.id)) continue;
      try {
        const invitation = await this.prisma.conversationInvitation.create({
          data: {
            conversationId,
            inviterId: auth.userId,
            inviteeId: candidate.id,
            expiresAt,
          },
          select: INVITATION_SELECT,
        });
        invited.push(candidate.ogcId as OgcId);
        const view = await this.receivedView(candidate.id, invitation);
        this.realtime.toUsers([candidate.id], 'group.invitation_created', { invitation: view });
        await this.notifications.notify([
          {
            userId: candidate.id,
            type: 'GROUP_INVITATION',
            dedupeKey: `invitation:${invitation.id}`,
            data: {
              invitationId: invitation.id,
              groupName: view.name,
              inviter: auth.ogcId,
            },
          },
        ]);
      } catch (error) {
        // Already invited (one pending invitation per person and group): not an error.
        if (
          !isUniqueViolation(error, 'conversation_invitations_one_pending') &&
          !isUniqueViolation(error, 'invitee_id')
        ) {
          throw error;
        }
        invited.push(candidate.ogcId as OgcId);
      }
    }
    return { invited };
  }

  private async receivedView(
    viewerId: string,
    row: {
      id: string;
      conversationId: string;
      createdAt: Date;
      expiresAt: Date;
      conversation: {
        type: 'DIRECT' | 'GROUP' | 'CHANNEL';
        groupProfile: { name: string; avatarKey: string | null } | null;
        _count: { participants: number };
      };
      inviter: {
        id: string;
        ogcId: string;
        profile: {
          displayName: string;
          avatarKey: string | null;
          profileVisibility: 'EVERYONE' | 'CONTACTS';
        } | null;
      } | null;
    },
  ): Promise<ReceivedInvitationView> {
    const inviter = row.inviter
      ? ((await this.relationships.summariesFor(viewerId, [row.inviter])).get(row.inviter.id) ??
        null)
      : null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      kind: row.conversation.type === 'CHANNEL' ? 'CHANNEL' : 'GROUP',
      name: row.conversation.groupProfile?.name ?? '',
      // The photo is shown to invitees through the invitation, not the members-only URL.
      avatarUrl: row.conversation.groupProfile?.avatarKey
        ? `/api/v1/invitations/${row.id}/avatar?v=${avatarVersion(row.conversation.groupProfile.avatarKey)}`
        : null,
      memberCount: row.conversation._count.participants,
      inviter,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** Pending invitations for the caller, newest first (expired ones are excluded). */
  async received(viewerId: string): Promise<ReceivedInvitationView[]> {
    const rows = await this.prisma.conversationInvitation.findMany({
      where: { inviteeId: viewerId, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { id: 'desc' },
      take: SENT_LIST_MAX,
      select: INVITATION_SELECT,
    });
    return Promise.all(rows.map((row) => this.receivedView(viewerId, row)));
  }

  /** A group photo for someone holding a pending invitation to it. */
  async invitationAvatar(viewerId: string, invitationId: string): Promise<string> {
    const row = await this.prisma.conversationInvitation.findFirst({
      where: {
        id: invitationId,
        inviteeId: viewerId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      select: { conversation: { select: { groupProfile: { select: { avatarKey: true } } } } },
    });
    const key = row?.conversation.groupProfile?.avatarKey;
    if (!key) throw invitationNotFound();
    return key;
  }

  /** Invitations of a group, for members who may invite. */
  async sent(viewerId: string, conversationId: string): Promise<SentInvitationView[]> {
    const access = await this.access.require(viewerId, conversationId);
    if (access.type === 'DIRECT' || !access.group) throw conversationNotFound();
    if (!canInvite(access.role, access.group.invitePolicy)) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'You cannot manage invitations');
    }
    const rows = await this.prisma.conversationInvitation.findMany({
      where: { conversationId },
      orderBy: { id: 'desc' },
      take: SENT_LIST_MAX,
      select: {
        id: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        invitee: {
          select: {
            id: true,
            ogcId: true,
            profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
          },
        },
        inviter: {
          select: {
            id: true,
            ogcId: true,
            profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
          },
        },
      },
    });
    const accounts = rows.flatMap((r) => (r.inviter ? [r.invitee, r.inviter] : [r.invitee]));
    const summaries = await this.relationships.summariesFor(viewerId, accounts);
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      invitee: summaries.get(r.invitee.id) ?? this.relationships.summary(r.invitee, false),
      inviter: r.inviter ? (summaries.get(r.inviter.id) ?? null) : null,
      status: r.status === 'PENDING' && r.expiresAt.getTime() <= now ? 'EXPIRED' : r.status,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  }

  /** Accepts an invitation: joins the group (idempotent), subject to capacity and archive state. */
  async accept(auth: AuthContext, invitationId: string): Promise<{ conversationId: string }> {
    const invitation = await this.prisma.conversationInvitation.findFirst({
      where: { id: invitationId, inviteeId: auth.userId },
      select: { id: true, conversationId: true, status: true, expiresAt: true, inviterId: true },
    });
    if (invitation?.status !== 'PENDING' || invitation.expiresAt <= new Date()) {
      throw invitationNotFound();
    }
    await this.membership.addMember(
      invitation.conversationId,
      auth.userId,
      'invitation',
      async (tx) => {
        const { count } = await tx.conversationInvitation.updateMany({
          where: { id: invitation.id, status: 'PENDING' },
          data: { status: 'ACCEPTED', respondedAt: new Date() },
        });
        if (count !== 1) throw invitationNotFound();
      },
    );
    if (invitation.inviterId) {
      await this.notifications.notify([
        {
          userId: invitation.inviterId,
          type: 'GROUP_MEMBER_ADDED',
          dedupeKey: `invitation-accepted:${invitation.id}`,
          data: { conversationId: invitation.conversationId, ogcId: auth.ogcId },
        },
      ]);
    }
    return { conversationId: invitation.conversationId };
  }

  async decline(viewerId: string, invitationId: string): Promise<void> {
    const { count } = await this.prisma.conversationInvitation.updateMany({
      where: { id: invitationId, inviteeId: viewerId, status: 'PENDING' },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    if (count !== 1) throw invitationNotFound();
  }

  /** The inviter, or an administrator who outranks them, can revoke a pending invitation. */
  async revoke(auth: AuthContext, invitationId: string): Promise<void> {
    const invitation = await this.prisma.conversationInvitation.findFirst({
      where: { id: invitationId, status: 'PENDING' },
      select: { id: true, conversationId: true, inviterId: true, inviteeId: true },
    });
    if (!invitation) throw invitationNotFound();
    // Non-members get the same 404 as for an unknown invitation.
    const access = await this.access
      .require(auth.userId, invitation.conversationId)
      .catch(() => undefined);
    if (!access) throw invitationNotFound();
    // The inviter, or the owner/an administrator (community-permissions.md).
    const allowed =
      invitation.inviterId === auth.userId || access.role === 'OWNER' || access.role === 'ADMIN';
    if (!allowed) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'You cannot revoke this invitation',
      );
    }
    const { count } = await this.prisma.conversationInvitation.updateMany({
      where: { id: invitation.id, status: 'PENDING' },
      data: { status: 'REVOKED', respondedAt: new Date() },
    });
    if (count === 1) {
      this.realtime.toUsers([invitation.inviteeId], 'group.invitation_revoked', {
        invitationId: invitation.id,
        conversationId: invitation.conversationId,
      });
    }
  }

  /** Marks overdue invitations expired and tells their inviters (once). */
  async expire(now = new Date()): Promise<number> {
    const overdue = await this.prisma.conversationInvitation.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      take: 1000,
      select: {
        id: true,
        inviterId: true,
        conversationId: true,
        conversation: { select: { groupProfile: { select: { name: true } } } },
      },
    });
    if (overdue.length === 0) return 0;
    const { count } = await this.prisma.conversationInvitation.updateMany({
      where: { id: { in: overdue.map((o) => o.id) }, status: 'PENDING' },
      data: { status: 'EXPIRED', respondedAt: now },
    });
    await this.notifications.notify(
      overdue.flatMap((o) =>
        o.inviterId
          ? [
              {
                userId: o.inviterId,
                type: 'INVITATION_EXPIRED' as const,
                dedupeKey: `invitation-expired:${o.id}`,
                data: {
                  conversationId: o.conversationId,
                  groupName: o.conversation.groupProfile?.name ?? '',
                },
              },
            ]
          : [],
      ),
    );
    return count;
  }
}
