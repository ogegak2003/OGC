import { HttpStatus, Injectable } from '@nestjs/common';
import type { OgcId } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  AccountStatus,
  CommunityRole,
  ConversationType,
  InvitePolicy,
  PostPolicy,
} from '../../generated/prisma/client.js';
import { canPost } from '../community/community-permissions.js';

export const conversationNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found');

export const messageNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Message not found');

export const archivedConversation = (): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'ARCHIVED', 'This group is archived and read-only');

/**
 * New messages are refused while the MLS tree still contains devices of people who are no
 * longer members (ADR-033): the sender's client must first commit their removal, so a removed
 * member can never decrypt anything sent after the removal.
 */
export const mlsMembershipStale = (): ApiException =>
  new ApiException(
    HttpStatus.CONFLICT,
    'MLS_MEMBERSHIP_STALE',
    'Group membership changed; update the encryption group and try again',
  );

export interface MemberRef {
  userId: string;
  ogcId: OgcId;
  status: AccountStatus;
  role: CommunityRole;
}

export interface GroupSettings {
  postPolicy: PostPolicy;
  invitePolicy: InvitePolicy;
  archived: boolean;
}

/** A conversation as seen by one of its participants. */
export interface ParticipantAccess {
  conversationId: string;
  type: ConversationType;
  version: bigint;
  mlsEpoch: bigint;
  viewerId: string;
  /** The viewer's role (always MEMBER in DIRECT conversations). */
  role: CommunityRole;
  /** The viewer's history starts after this version (groups: when they joined). */
  visibleFrom: bigint;
  /** Every current participant, the viewer included. */
  members: MemberRef[];
  /** Participant user IDs other than the viewer. */
  otherIds: string[];
  /** Blocks between any two participants (blocker → blocked). */
  blocks: { blockerId: string; blockedId: string }[];
  /** Accounts whose devices are in the current MLS tree. */
  mlsMemberUserIds: string[];
  /** Groups and encrypted channels only. */
  group: GroupSettings | null;
  /** DIRECT only: the other participant. */
  peerId: string | null;
  peerOgcId: OgcId | null;
  peerStatus: AccountStatus | null;
  /** DIRECT only: the viewer blocked the peer. */
  blockedByViewer: boolean;
  /** DIRECT only: the peer blocked the viewer — never revealed to the viewer. */
  blockedByPeer: boolean;
}

/** People `userId` has blocked among the participants (their reactions are hidden for them). */
export function blockedBy(access: ParticipantAccess, userId: string): Set<string> {
  return new Set(access.blocks.filter((b) => b.blockerId === userId).map((b) => b.blockedId));
}

/** Whether a block exists between two participants, in either direction. */
export function blockedEitherWay(access: ParticipantAccess, a: string, b: string): boolean {
  return access.blocks.some(
    (x) => (x.blockerId === a && x.blockedId === b) || (x.blockerId === b && x.blockedId === a),
  );
}

/**
 * The single authorization point for conversations: the caller must be a
 * current participant. Non-participants (including removed members) get the
 * same 404 as for a nonexistent ID, so conversation IDs cannot be probed (no
 * IDOR, no existence oracle).
 */
@Injectable()
export class ConversationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(userId: string, conversationId: string): Promise<ParticipantAccess> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, participants: { some: { userId } } },
      select: {
        id: true,
        type: true,
        version: true,
        mlsEpoch: true,
        mlsMemberUserIds: true,
        participants: {
          select: {
            userId: true,
            role: true,
            visibleFromVersion: true,
            user: { select: { ogcId: true, status: true } },
          },
        },
        groupProfile: { select: { postPolicy: true, invitePolicy: true, archivedAt: true } },
      },
    });
    if (!conversation) throw conversationNotFound();
    const members: MemberRef[] = conversation.participants.map((p) => ({
      userId: p.userId,
      ogcId: p.user.ogcId as OgcId,
      status: p.user.status,
      role: p.role,
    }));
    const me = members.find((m) => m.userId === userId);
    if (!me) throw conversationNotFound();
    const visibleFrom =
      conversation.participants.find((p) => p.userId === userId)?.visibleFromVersion ?? 0n;
    const otherIds = members.filter((m) => m.userId !== userId).map((m) => m.userId);
    const memberIds = members.map((m) => m.userId);
    const blocks =
      otherIds.length === 0
        ? []
        : await this.prisma.block.findMany({
            where: { blockerId: { in: memberIds }, blockedId: { in: memberIds } },
            select: { blockerId: true, blockedId: true },
          });

    const direct = conversation.type === 'DIRECT';
    const peer = direct ? members.find((m) => m.userId !== userId) : undefined;
    if (direct && !peer) throw conversationNotFound();
    const profile = conversation.groupProfile;
    return {
      conversationId: conversation.id,
      type: conversation.type,
      version: conversation.version,
      mlsEpoch: conversation.mlsEpoch,
      viewerId: userId,
      role: me.role,
      visibleFrom,
      members,
      otherIds,
      blocks,
      mlsMemberUserIds: conversation.mlsMemberUserIds,
      group: profile
        ? {
            postPolicy: profile.postPolicy,
            invitePolicy: profile.invitePolicy,
            archived: profile.archivedAt !== null,
          }
        : null,
      peerId: peer?.userId ?? null,
      peerOgcId: peer?.ogcId ?? null,
      peerStatus: peer?.status ?? null,
      blockedByViewer: peer
        ? blocks.some((b) => b.blockerId === userId && b.blockedId === peer.userId)
        : false,
      blockedByPeer: peer
        ? blocks.some((b) => b.blockerId === peer.userId && b.blockedId === userId)
        : false,
    };
  }

  async blocksBetween(
    viewerId: string,
    peerId: string,
  ): Promise<{ blockedByViewer: boolean; blockedByPeer: boolean }> {
    const blocks = await this.prisma.block.findMany({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: peerId },
          { blockerId: peerId, blockedId: viewerId },
        ],
      },
      select: { blockerId: true },
    });
    return {
      blockedByViewer: blocks.some((b) => b.blockerId === viewerId),
      blockedByPeer: blocks.some((b) => b.blockerId === peerId),
    };
  }

  /**
   * DIRECT: sending is refused when the viewer blocked the peer (they know) or
   * the peer account is no longer active. When the *peer* blocked the viewer,
   * sending "succeeds" but the message is withheld from the peer, so the block
   * is not revealed.
   *
   * GROUP / CHANNEL: refused when archived or when the post policy excludes the
   * viewer's role.
   */
  assertCanSend(access: ParticipantAccess): void {
    if (access.type === 'DIRECT') {
      if (access.blockedByViewer) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          'BLOCKED',
          'You blocked this person. Unblock them to send messages.',
        );
      }
      if (access.peerStatus !== 'ACTIVE') {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          'FORBIDDEN',
          'This conversation is unavailable',
        );
      }
      return;
    }
    this.assertWritable(access);
    if (access.group && !canPost(access.role, access.group.postPolicy)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        access.group.postPolicy === 'MODERATORS'
          ? 'Only moderators and administrators can post here'
          : 'Only administrators can post here',
      );
    }
  }

  /** Reactions, receipts of membership changes etc.: allowed unless the group is archived. */
  assertWritable(access: ParticipantAccess): void {
    if (access.group?.archived) throw archivedConversation();
  }

  /**
   * Content may only be encrypted to current members: refuses while the MLS tree
   * includes devices of someone who left or was removed (ADR-033).
   */
  assertMlsMembershipCurrent(access: ParticipantAccess): void {
    const current = new Set(access.members.map((m) => m.userId));
    if (access.mlsMemberUserIds.some((id) => !current.has(id))) throw mlsMembershipStale();
  }
}
