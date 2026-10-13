import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { OgcId } from '@ogc/types';
import { GROUP_MEMBER_LIMIT } from '@ogc/validation';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { CommunityRole, Prisma } from '../../generated/prisma/client.js';
import {
  archivedConversation,
  conversationNotFound,
} from '../conversations/conversation-access.service.js';
import {
  lockConversation,
  recordConversationEvent,
} from '../conversations/conversation-version.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { ObjectStorage } from '../storage/object-storage.js';

export const memberLimitReached = (): ApiException =>
  new ApiException(
    HttpStatus.CONFLICT,
    'MEMBER_LIMIT_REACHED',
    `Groups can have at most ${String(GROUP_MEMBER_LIMIT)} members`,
  );

export type JoinVia = 'invitation' | 'link' | 'created';

/**
 * Membership changes of groups and private encrypted channels (ADR-031/033).
 * Every change runs under the conversation row lock, appends a timeline event
 * at the next version, and — after commit — tells members' devices to
 * reconcile the MLS group (`devices.changed`): joiners' devices are added and
 * leavers' devices removed. Until a removal is committed in MLS, the server
 * refuses new messages (MLS_MEMBERSHIP_STALE), so a removed member can never
 * decrypt anything sent after their removal.
 */
@Injectable()
export class GroupMembershipService {
  private readonly logger = new Logger(GroupMembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisher,
    private readonly events: DomainEventBus,
    private readonly conversations: ConversationsService,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Adds `userId` as a MEMBER. Idempotent: an existing member is not changed
   * (`joined: false`). Refuses archived groups and full groups. Runs `extra`
   * inside the same transaction (e.g. marking an invitation accepted or
   * consuming a link use) only when the person actually joins.
   */
  async addMember(
    conversationId: string,
    userId: string,
    via: JoinVia,
    extra?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{ joined: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      if (!(await lockConversation(tx, conversationId))) throw conversationNotFound();
      const [profile, participants] = await Promise.all([
        tx.groupProfile.findUnique({
          where: { conversationId },
          select: { archivedAt: true },
        }),
        tx.conversationParticipant.findMany({
          where: { conversationId },
          select: { userId: true },
        }),
      ]);
      if (!profile) throw conversationNotFound();
      if (participants.some((p) => p.userId === userId)) return undefined;
      if (profile.archivedAt) throw archivedConversation();
      if (participants.length >= GROUP_MEMBER_LIMIT) throw memberLimitReached();
      if (extra) await extra(tx);
      const version = await recordConversationEvent(tx, conversationId, {
        type: 'MEMBER_JOINED',
        actorId: userId,
        subjectId: userId,
        detail: { via },
      });
      // History starts just before the join event, so the joiner sees "you joined".
      await tx.conversationParticipant.create({
        data: {
          conversationId,
          userId,
          role: 'MEMBER',
          visibleFromVersion: version - 1n,
          lastReadSeq: version - 1n,
          lastDeliveredSeq: version - 1n,
        },
      });
      return { version, others: participants.map((p) => p.userId) };
    });
    if (!result) return { joined: false };

    const ogcId = await this.ogcIdOf(userId);
    this.realtime.toUsers(result.others, 'group.member_joined', {
      conversationId,
      version: Number(result.version),
      ogcId,
    });
    // Existing members' devices add the newcomer's devices to the MLS group.
    this.realtime.toUsers([...result.others, userId], 'devices.changed', { conversationId });
    this.events.publish({ type: 'membership.changed', conversationId, userIds: [userId] });
    await this.announceTo(userId, conversationId);
    return { joined: true };
  }

  /** Sends the conversation to a (new) member's devices. */
  async announceTo(userId: string, conversationId: string): Promise<void> {
    try {
      const conversation = await this.conversations.view(userId, conversationId);
      this.realtime.toUsers([userId], 'group.created', { conversation });
    } catch (error) {
      this.logger.warn({ err: error }, 'Group announcement failed');
    }
  }

  /**
   * Removes a participant (left or removed). Pending Welcomes for their devices
   * are deleted. When the last member leaves, the group is deleted.
   */
  async removeMember(
    conversationId: string,
    userId: string,
    change: { type: 'MEMBER_LEFT' | 'MEMBER_REMOVED'; actorId: string },
  ): Promise<{ removed: boolean; deleted: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      if (!(await lockConversation(tx, conversationId))) throw conversationNotFound();
      const { count } = await tx.conversationParticipant.deleteMany({
        where: { conversationId, userId },
      });
      if (count === 0) return undefined;
      await tx.mlsWelcome.deleteMany({
        where: { conversationId, deviceKey: { userId } },
      });
      const remaining = await tx.conversationParticipant.findMany({
        where: { conversationId },
        select: { userId: true },
      });
      if (remaining.length === 0) return { version: 0n, remaining: [], last: true };
      const version = await recordConversationEvent(tx, conversationId, {
        type: change.type,
        actorId: change.actorId,
        subjectId: userId,
      });
      return { version, remaining: remaining.map((r) => r.userId), last: false };
    });
    if (!result) return { removed: false, deleted: false };
    if (result.last) {
      await this.deleteConversation(conversationId, [userId]);
      return { removed: true, deleted: true };
    }

    const ogcId = await this.ogcIdOf(userId);
    const payload = { conversationId, version: Number(result.version), ogcId };
    const event = change.type === 'MEMBER_LEFT' ? 'group.member_left' : 'group.member_removed';
    this.realtime.toUsers(result.remaining, event, payload);
    // The person's own devices erase the conversation.
    this.realtime.toUsers([userId], 'group.member_removed', payload);
    // Remaining devices remove the person's devices from the MLS group.
    this.realtime.toUsers(result.remaining, 'devices.changed', { conversationId });
    this.events.publish({ type: 'membership.changed', conversationId, userIds: [userId] });
    return { removed: true, deleted: false };
  }

  /** Changes a member's role (never to or from OWNER; that is a transfer). */
  async setRole(
    conversationId: string,
    actorId: string,
    targetId: string,
    role: Exclude<CommunityRole, 'OWNER'>,
  ): Promise<bigint | undefined> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockConversation(tx, conversationId))) throw conversationNotFound();
      const { count } = await tx.conversationParticipant.updateMany({
        where: { conversationId, userId: targetId, role: { not: 'OWNER' }, NOT: { role } },
        data: { role },
      });
      if (count === 0) return undefined;
      return recordConversationEvent(tx, conversationId, {
        type: 'ROLE_CHANGED',
        actorId,
        subjectId: targetId,
        detail: { role },
      });
    });
  }

  /**
   * Deletes the conversation with everything in it (messages, MLS state,
   * attachments, events) and removes stored files. Irreversible.
   */
  async deleteConversation(conversationId: string, notifyUserIds: string[]): Promise<void> {
    const [attachments, profile] = await Promise.all([
      this.prisma.attachment.findMany({
        where: { conversationId },
        select: { storageKey: true },
      }),
      this.prisma.groupProfile.findUnique({
        where: { conversationId },
        select: { avatarKey: true },
      }),
    ]);
    await this.prisma.conversation.deleteMany({ where: { id: conversationId } });
    const keys = [
      ...attachments.map((a) => a.storageKey),
      ...(profile?.avatarKey ? [profile.avatarKey] : []),
    ];
    await Promise.all(
      keys.map((key) =>
        this.storage.delete(key).catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Stored object cleanup failed');
        }),
      ),
    );
    this.realtime.toUsers(notifyUserIds, 'group.deleted', { conversationId });
    this.events.publish({ type: 'membership.changed', conversationId, userIds: notifyUserIds });
  }

  private async ogcIdOf(userId: string): Promise<OgcId> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ogcId: true },
    });
    return user.ogcId as OgcId;
  }
}
