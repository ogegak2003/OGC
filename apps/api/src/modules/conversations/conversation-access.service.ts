import { HttpStatus, Injectable } from '@nestjs/common';
import type { OgcId } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AccountStatus } from '../../generated/prisma/client.js';

export const conversationNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found');

export const messageNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Message not found');

/** A conversation as seen by one of its participants. */
export interface ParticipantAccess {
  conversationId: string;
  version: bigint;
  mlsEpoch: bigint;
  peerId: string;
  peerOgcId: OgcId;
  peerStatus: AccountStatus;
  /** The viewer blocked the peer. */
  blockedByViewer: boolean;
  /** The peer blocked the viewer — never revealed to the viewer. */
  blockedByPeer: boolean;
}

/**
 * The single authorization point for conversations: the caller must be a
 * participant. Non-participants get the same 404 as for a nonexistent ID, so
 * conversation IDs cannot be probed (no IDOR, no existence oracle).
 */
@Injectable()
export class ConversationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(userId: string, conversationId: string): Promise<ParticipantAccess> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, participants: { some: { userId } } },
      select: {
        id: true,
        version: true,
        mlsEpoch: true,
        participants: { select: { userId: true, user: { select: { ogcId: true, status: true } } } },
      },
    });
    if (!conversation) throw conversationNotFound();
    const peer = conversation.participants.find((p) => p.userId !== userId);
    if (!peer) throw conversationNotFound();
    const blocks = await this.blocksBetween(userId, peer.userId);
    return {
      conversationId: conversation.id,
      version: conversation.version,
      mlsEpoch: conversation.mlsEpoch,
      peerId: peer.userId,
      peerOgcId: peer.user.ogcId as OgcId,
      peerStatus: peer.user.status,
      ...blocks,
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
   * Sending is refused when the viewer blocked the peer (they know) or the peer
   * account is no longer active. When the *peer* blocked the viewer, sending
   * "succeeds" but the message is withheld from the peer, so the block is not revealed.
   */
  assertCanSend(access: ParticipantAccess): void {
    if (access.blockedByViewer) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'BLOCKED',
        'You blocked this person. Unblock them to send messages.',
      );
    }
    if (access.peerStatus !== 'ACTIVE') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'This conversation is unavailable');
    }
  }
}
