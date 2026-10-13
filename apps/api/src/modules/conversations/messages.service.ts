import { HttpStatus, Injectable } from '@nestjs/common';
import { editAad, equalBytes, inspectApplicationMessage, messageAad } from '@ogc/e2ee';
import type {
  ConversationEventView,
  MessagePage,
  MessageView,
  OgcId,
  ReactionType,
  SyncItem,
  SyncPage,
} from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import type { CommunityRole, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { canModerate, outranks } from '../community/community-permissions.js';
import { DeviceKeysService, invalidMls } from '../e2ee/device-keys.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import {
  ConversationAccessService,
  type ParticipantAccess,
  blockedBy,
  blockedEitherWay,
  conversationNotFound,
  messageNotFound,
  mlsMembershipStale,
} from './conversation-access.service.js';
import { nextVersion, recordConversationEvent, staleEpoch } from './conversation-version.js';
import { MESSAGE_SELECT, type MessageRow, toMessageView, visibleTo } from './message-views.js';
import {
  MESSAGE_DELETE_FOR_EVERYONE_WINDOW_MS,
  MESSAGE_EDIT_WINDOW_MS,
} from './messaging.constants.js';
import { bytesFromBase64, bytesToBase64 } from '../../common/bytes.js';

export interface SendMessageInput {
  clientMessageId: string;
  epoch: number;
  ciphertext: string;
  replyToId?: string | undefined;
  forwardedFromId?: string | undefined;
  attachmentIds?: string[] | undefined;
  mentions?: OgcId[] | undefined;
}

/**
 * Checks the cleartext MLS header of an application message: it must belong to
 * this conversation's group, the stated epoch, and carry exactly the expected
 * authenticated data (which binds it to its message ID). The content itself
 * stays encrypted.
 */
function checkCiphertext(
  ciphertext: string,
  conversationId: string,
  epoch: number,
  aad: Uint8Array,
): void {
  let header;
  try {
    header = inspectApplicationMessage(ciphertext);
  } catch {
    throw invalidMls();
  }
  if (
    header.groupId !== conversationId ||
    header.epoch !== BigInt(epoch) ||
    !equalBytes(header.authenticatedData, aad)
  ) {
    throw invalidMls('Encrypted message does not match its envelope');
  }
}

const forbidden = (message: string): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);

/**
 * Re-checks membership under the conversation row lock taken by `nextVersion`:
 * the sender must still be a participant and the MLS tree must not contain
 * anyone who has left or been removed (ADR-033). Membership changes take the
 * same lock, so this cannot race with a removal.
 */
async function assertMembershipUnderLock(
  tx: Prisma.TransactionClient,
  conversationId: string,
  senderId: string,
  mlsMemberUserIds: string[],
): Promise<void> {
  const participants = await tx.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  const current = new Set(participants.map((p) => p.userId));
  if (!current.has(senderId)) throw conversationNotFound();
  if (mlsMemberUserIds.some((id) => !current.has(id))) throw mlsMembershipStale();
}

/**
 * The message lifecycle (ADR-022/025): CREATED on the device → SENT when this
 * service has persisted it (the API response) → DELIVERED / READ through
 * per-participant high-water marks. Realtime events are emitted only after the
 * database transaction commits; sync recovers anything a socket missed.
 *
 * The same lifecycle serves DIRECT conversations, groups and private encrypted
 * channels (ADR-031). Differences: in DIRECT conversations a peer's block
 * withholds messages (so the block is not revealed); in groups messages from a
 * blocked member stay visible to everyone (clients collapse them) while their
 * reactions are hidden from the blocker, and moderators may delete others'
 * messages for everyone.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly devices: DeviceKeysService,
    private readonly realtime: RealtimePublisher,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
  ) {}

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Idempotent on (sender, clientMessageId): retries return the original message. */
  async send(
    auth: AuthContext,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<MessageView> {
    const deviceKeyId = await this.devices.requireActiveKey(auth);
    const access = await this.access.require(auth.userId, conversationId);

    const replay = await this.findBySubmission(auth.userId, input.clientMessageId);
    if (replay) {
      if (replay.conversationId !== conversationId) {
        throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'Message ID already used');
      }
      return toMessageView(replay, blockedBy(access, auth.userId));
    }

    this.access.assertCanSend(access);
    this.access.assertMlsMembershipCurrent(access);
    checkCiphertext(
      input.ciphertext,
      conversationId,
      input.epoch,
      messageAad(conversationId, input.clientMessageId),
    );
    const withheld = access.type === 'DIRECT' && access.blockedByPeer;

    let row: MessageRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const { version, mlsEpoch, mlsMemberUserIds } = await nextVersion(tx, conversationId, {
          activity: true,
        });
        if (mlsEpoch !== BigInt(input.epoch)) throw staleEpoch();
        await assertMembershipUnderLock(tx, conversationId, auth.userId, mlsMemberUserIds);

        if (input.replyToId) {
          const target = await tx.message.findFirst({
            where: { id: input.replyToId, conversationId, ...visibleTo(auth.userId) },
            select: { id: true },
          });
          if (!target) {
            throw new ApiException(
              HttpStatus.BAD_REQUEST,
              'VALIDATION_FAILED',
              'replyToId: Message not found in this conversation',
            );
          }
        }
        if (input.forwardedFromId) {
          // The source must be a message the sender can currently read, in any of their conversations.
          const source = await tx.message.findFirst({
            where: {
              id: input.forwardedFromId,
              deletedAt: null,
              conversation: { participants: { some: { userId: auth.userId } } },
              ...visibleTo(auth.userId),
            },
            select: { id: true },
          });
          if (!source) {
            throw new ApiException(
              HttpStatus.BAD_REQUEST,
              'VALIDATION_FAILED',
              'forwardedFromId: Message not found',
            );
          }
        }

        const created = await tx.message.create({
          data: {
            conversationId,
            seq: version,
            version,
            senderId: auth.userId,
            senderDeviceKeyId: deviceKeyId,
            clientMessageId: input.clientMessageId,
            epoch: BigInt(input.epoch),
            ciphertext: bytesFromBase64(input.ciphertext),
            replyToId: input.replyToId ?? null,
            forwarded: input.forwardedFromId !== undefined,
            withheld,
          },
          select: { id: true },
        });

        const attachmentIds = [...new Set(input.attachmentIds ?? [])];
        if (attachmentIds.length > 0) {
          const { count } = await tx.attachment.updateMany({
            where: {
              id: { in: attachmentIds },
              uploaderId: auth.userId,
              conversationId,
              messageId: null,
            },
            data: { messageId: created.id },
          });
          if (count !== attachmentIds.length) {
            throw new ApiException(
              HttpStatus.BAD_REQUEST,
              'VALIDATION_FAILED',
              'attachmentIds: Unknown or already used attachment',
            );
          }
        }
        // The sender has, by definition, seen their own message.
        await tx.conversationParticipant.update({
          where: { conversationId_userId: { conversationId, userId: auth.userId } },
          data: { lastReadSeq: version, lastDeliveredSeq: version },
        });
        return tx.message.findUniqueOrThrow({ where: { id: created.id }, select: MESSAGE_SELECT });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'client_message_id')) {
        const existing = await this.findBySubmission(auth.userId, input.clientMessageId);
        if (existing?.conversationId === conversationId)
          return toMessageView(existing, blockedBy(access, auth.userId));
      }
      if (error instanceof ApiException) {
        this.metrics.failures.inc({ operation: 'send', reason: String(error.getStatus()) });
      }
      throw error;
    }

    this.metrics.messagesSent.inc();
    // Push goes to active members who have not blocked the sender (never revealed to the sender).
    const recipients = row.withheld
      ? []
      : access.members
          .filter(
            (m) =>
              m.userId !== auth.userId &&
              m.status === 'ACTIVE' &&
              !access.blocks.some((b) => b.blockerId === m.userId && b.blockedId === auth.userId),
          )
          .map((m) => m.userId);
    const mentionSet = new Set(input.mentions ?? []);
    const mentionedIds =
      access.type === 'DIRECT'
        ? []
        : recipients.filter((id) =>
            mentionSet.has(access.members.find((m) => m.userId === id)?.ogcId ?? ('' as OgcId)),
          );
    this.publishMessage('message.created', row, auth.userId, access);
    this.events.publish({
      type: 'message.created',
      conversationId,
      messageId: row.id,
      senderId: auth.userId,
      recipientIds: recipients,
      mentionedIds,
    });
    return toMessageView(row, blockedBy(access, auth.userId));
  }

  private findBySubmission(senderId: string, clientMessageId: string): Promise<MessageRow | null> {
    return this.prisma.message.findUnique({
      where: { senderId_clientMessageId: { senderId, clientMessageId } },
      select: MESSAGE_SELECT,
    });
  }

  // -------------------------------------------------------------------------
  // Edit, delete, hide, react
  // -------------------------------------------------------------------------

  private async loadForViewer(
    userId: string,
    messageId: string,
  ): Promise<{ row: MessageRow; access: ParticipantAccess }> {
    const row = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversation: { participants: { some: { userId } } },
        ...visibleTo(userId),
      },
      select: MESSAGE_SELECT,
    });
    if (!row) throw messageNotFound();
    const access = await this.access.require(userId, row.conversationId);
    if (row.seq <= access.visibleFrom) throw messageNotFound();
    return { row, access };
  }

  /** Replaces the ciphertext with a new revision. Sender only, within the edit window. */
  async edit(
    auth: AuthContext,
    messageId: string,
    input: { epoch: number; ciphertext: string },
  ): Promise<MessageView> {
    const deviceKeyId = await this.devices.requireActiveKey(auth);
    const { row, access } = await this.loadForViewer(auth.userId, messageId);
    if (row.senderId !== auth.userId) throw forbidden('You can only edit your own messages');
    if (row.deletedAt)
      throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This message was deleted');
    this.access.assertCanSend(access);
    if (access.blockedByPeer || Date.now() - row.createdAt.getTime() > MESSAGE_EDIT_WINDOW_MS) {
      throw forbidden('This message can no longer be edited');
    }
    this.access.assertMlsMembershipCurrent(access);
    const revision = row.revision + 1;
    checkCiphertext(
      input.ciphertext,
      row.conversationId,
      input.epoch,
      editAad(row.conversationId, row.clientMessageId, revision),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const { version, mlsEpoch, mlsMemberUserIds } = await nextVersion(tx, row.conversationId);
      if (mlsEpoch !== BigInt(input.epoch)) throw staleEpoch();
      await assertMembershipUnderLock(tx, row.conversationId, auth.userId, mlsMemberUserIds);
      const now = new Date();
      // Compare-and-set on the revision: two concurrent edits cannot both win.
      const { count } = await tx.message.updateMany({
        where: { id: messageId, revision: row.revision, deletedAt: null },
        data: {
          ciphertext: bytesFromBase64(input.ciphertext),
          epoch: BigInt(input.epoch),
          revision,
          editedAt: now,
          version,
        },
      });
      if (count !== 1)
        throw new ApiException(
          HttpStatus.CONFLICT,
          'CONFLICT',
          'The message changed; reload and try again',
        );
      await tx.messageEdit.create({
        data: { messageId, revision, editorDeviceKeyId: deviceKeyId, editedAt: now },
      });
      return tx.message.findUniqueOrThrow({ where: { id: messageId }, select: MESSAGE_SELECT });
    });
    this.publishMessage('message.updated', updated, auth.userId, access);
    return toMessageView(updated, blockedBy(access, auth.userId));
  }

  /**
   * "Delete for everyone" removes the ciphertext, reactions and attachment
   * blobs from the server and tells every device to erase its local copy.
   * It cannot reach copies already exported, screenshotted or backed up.
   * Metadata (that a message existed and was deleted) is kept.
   *
   * Senders can do this within the time window. In groups and encrypted
   * channels, owners, admins and moderators can also remove messages of
   * lower-ranked members (or former members) at any time; that removal is
   * recorded in the timeline and the audit log, without content.
   */
  async deleteForEveryone(auth: AuthContext, messageId: string, meta: RequestMeta): Promise<void> {
    const { row, access } = await this.loadForViewer(auth.userId, messageId);
    const own = row.senderId === auth.userId;
    if (!own) this.assertCanModerateMessage(access, row.senderId);
    if (row.deletedAt) return;
    if (access.type !== 'DIRECT') this.access.assertWritable(access);
    if (own && Date.now() - row.createdAt.getTime() > MESSAGE_DELETE_FOR_EVERYONE_WINDOW_MS) {
      throw forbidden(
        'This message is too old to delete for everyone; delete it for yourself instead',
      );
    }
    const { updated, storageKeys } = await this.prisma.$transaction(async (tx) => {
      const { version } = await nextVersion(tx, row.conversationId);
      const { count } = await tx.message.updateMany({
        where: { id: messageId, deletedAt: null },
        data: { ciphertext: null, deletedAt: new Date(), version },
      });
      const attachments = await tx.attachment.findMany({
        where: { messageId },
        select: { storageKey: true },
      });
      if (count === 1) {
        await tx.messageReaction.deleteMany({ where: { messageId } });
        await tx.attachment.deleteMany({ where: { messageId } });
        if (!own) {
          await recordConversationEvent(tx, row.conversationId, {
            type: 'MESSAGE_REMOVED',
            actorId: auth.userId,
            subjectId: row.senderId,
            detail: { messageId },
          });
        }
        await this.audit.record(
          {
            type: 'MESSAGE_DELETED_FOR_EVERYONE',
            userId: auth.userId,
            sessionId: auth.sessionId,
            meta,
            details: { conversationId: row.conversationId, messageId, moderation: !own },
          },
          tx,
        );
      }
      return {
        updated: await tx.message.findUniqueOrThrow({
          where: { id: messageId },
          select: MESSAGE_SELECT,
        }),
        storageKeys: count === 1 ? attachments.map((a) => a.storageKey) : [],
      };
    });
    await Promise.all(storageKeys.map((key) => this.storage.delete(key)));
    this.publishMessage('message.deleted', updated, auth.userId, access);
  }

  /** Moderators act on lower-ranked members, or on messages of people who already left. */
  private assertCanModerateMessage(access: ParticipantAccess, senderId: string | null): void {
    if (access.type === 'DIRECT' || !canModerate(access.role)) {
      throw forbidden('You can only delete your own messages for everyone');
    }
    const sender = access.members.find((m) => m.userId === senderId);
    const senderRole: CommunityRole = sender?.role ?? 'MEMBER';
    if (sender && !outranks(access.role, senderRole)) {
      throw forbidden('You cannot remove messages of members with the same or a higher role');
    }
  }

  /** "Delete for me": hides the message on all of the caller's devices only. Idempotent. */
  async hide(auth: AuthContext, messageId: string): Promise<void> {
    const row = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversation: { participants: { some: { userId: auth.userId } } },
        OR: [{ withheld: false }, { senderId: auth.userId }],
      },
      select: { id: true, conversationId: true },
    });
    if (!row) throw messageNotFound();
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.messageHide.findUnique({
        where: { userId_messageId: { userId: auth.userId, messageId } },
      });
      if (existing) return undefined;
      const { version } = await nextVersion(tx, row.conversationId);
      await tx.messageHide.create({
        data: { userId: auth.userId, messageId, conversationId: row.conversationId, version },
      });
      return version;
    });
    if (result !== undefined) {
      this.realtime.toUsers([auth.userId], 'message.hidden', {
        conversationId: row.conversationId,
        messageId,
        version: Number(result),
      });
    }
  }

  async react(
    auth: AuthContext,
    messageId: string,
    reaction: ReactionType,
    add: boolean,
  ): Promise<void> {
    const { row, access } = await this.loadForViewer(auth.userId, messageId);
    if (row.deletedAt)
      throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This message was deleted');
    if (add) {
      if (access.type === 'DIRECT') this.access.assertCanSend(access);
      else this.access.assertWritable(access);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const key = { messageId_userId_reaction: { messageId, userId: auth.userId, reaction } };
      const exists = await tx.messageReaction.findUnique({ where: key });
      if (add === (exists !== null)) return undefined;
      const { version } = await nextVersion(tx, row.conversationId);
      if (add) {
        await tx.messageReaction.create({ data: { messageId, userId: auth.userId, reaction } });
      } else {
        await tx.messageReaction.delete({ where: key });
      }
      await tx.message.update({ where: { id: messageId }, data: { version } });
      return tx.message.findUniqueOrThrow({ where: { id: messageId }, select: MESSAGE_SELECT });
    });
    if (!updated) return;
    // The reactor's devices always learn it; others only without a block either way, and
    // never for a message withheld from them.
    const audience = access.members
      .map((m) => m.userId)
      .filter(
        (id) =>
          id === auth.userId ||
          (!blockedEitherWay(access, auth.userId, id) &&
            !(updated.withheld && updated.senderId !== id)),
      );
    for (const { userIds, hidden } of viewerGroups(access, audience)) {
      const view = toMessageView(updated, hidden);
      this.realtime.toUsers(userIds, 'message.reaction', {
        conversationId: view.conversationId,
        messageId: view.id,
        version: view.version,
        reactions: view.reactions,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  /** Advances the caller's read (and delivered) high-water mark. Never moves backwards. */
  async markRead(auth: AuthContext, conversationId: string, seq: number): Promise<void> {
    await this.advanceReceipt(auth, conversationId, seq, 'read');
  }

  async markDelivered(auth: AuthContext, conversationId: string, seq: number): Promise<void> {
    await this.advanceReceipt(auth, conversationId, seq, 'delivered');
  }

  private async advanceReceipt(
    auth: AuthContext,
    conversationId: string,
    requested: number,
    kind: 'read' | 'delivered',
  ): Promise<void> {
    const access = await this.access.require(auth.userId, conversationId);
    // Cannot acknowledge beyond what exists.
    const seq = BigInt(Math.min(requested, Number(access.version)));
    const now = new Date();
    const previous = await this.prisma.conversationParticipant.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId: auth.userId } },
      select: { lastReadSeq: true, lastDeliveredSeq: true },
    });
    const { count } = await this.prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId: auth.userId,
        ...(kind === 'read' ? { lastReadSeq: { lt: seq } } : { lastDeliveredSeq: { lt: seq } }),
      },
      data:
        kind === 'read'
          ? {
              lastReadSeq: seq,
              readAt: now,
              ...(previous.lastDeliveredSeq < seq ? { lastDeliveredSeq: seq } : {}),
            }
          : { lastDeliveredSeq: seq },
    });
    if (count === 0) return;

    if (kind === 'delivered' || previous.lastDeliveredSeq < seq) {
      const newest = await this.prisma.message.findFirst({
        where: {
          conversationId,
          seq: { lte: seq, gt: previous.lastDeliveredSeq },
          senderId: { in: access.otherIds },
        },
        orderBy: { seq: 'desc' },
        select: { createdAt: true },
      });
      if (newest)
        this.metrics.deliveryLatency.observe((now.getTime() - newest.createdAt.getTime()) / 1000);
    }
    const payload = { conversationId, ogcId: auth.ogcId, seq: Number(seq) };
    const event = kind === 'read' ? 'message.read' : 'message.delivered';
    // The caller's other devices always learn it (unread counts); others only without a block.
    const audience = [
      auth.userId,
      ...access.otherIds.filter((id) => !blockedEitherWay(access, auth.userId, id)),
    ];
    this.realtime.toUsers(audience, event, payload);
    if (kind === 'read' && previous.lastDeliveredSeq < seq) {
      this.realtime.toUsers(audience, 'message.delivered', payload);
    }
  }

  // -------------------------------------------------------------------------
  // Sync and history
  // -------------------------------------------------------------------------

  /**
   * Everything that changed after `after`, in version order: new and changed
   * messages, MLS commits (needed to keep decrypting), membership/settings
   * events and the caller's own "delete for me" hides. Reading the
   * conversation version first gives a consistent snapshot: every version up
   * to it has committed.
   */
  async sync(
    auth: AuthContext,
    conversationId: string,
    after: number,
    limit: number,
  ): Promise<SyncPage> {
    const access = await this.access.require(auth.userId, conversationId);
    const upTo = access.version;
    // Members of a group never receive what happened before they joined.
    const from = BigInt(after) > access.visibleFrom ? BigInt(after) : access.visibleFrom;
    if (from >= upTo) return { items: [], version: Number(upTo), hasMore: false };

    const range = { gt: from, lte: upTo };
    const [messages, commits, hides, events] = await Promise.all([
      this.prisma.message.findMany({
        where: {
          conversationId,
          version: range,
          seq: { gt: access.visibleFrom },
          ...visibleTo(auth.userId),
        },
        orderBy: { version: 'asc' },
        take: limit + 1,
        select: MESSAGE_SELECT,
      }),
      this.prisma.mlsCommit.findMany({
        where: { conversationId, version: range },
        orderBy: { version: 'asc' },
        take: limit + 1,
        select: { version: true, epoch: true, data: true },
      }),
      this.prisma.messageHide.findMany({
        where: { userId: auth.userId, conversationId, version: range },
        orderBy: { version: 'asc' },
        take: limit + 1,
        select: { version: true, messageId: true },
      }),
      access.type === 'DIRECT'
        ? Promise.resolve([])
        : this.prisma.conversationEvent.findMany({
            where: { conversationId, version: range },
            orderBy: { version: 'asc' },
            take: limit + 1,
          }),
    ]);
    const hidden = blockedBy(access, auth.userId);
    const eventViews = await this.eventViews(events);
    const items: SyncItem[] = [
      ...messages.map((m): SyncItem => ({
        type: 'message',
        version: Number(m.version),
        message: toMessageView(m, hidden),
      })),
      ...commits.map((c): SyncItem => ({
        type: 'commit',
        version: Number(c.version),
        epoch: Number(c.epoch),
        commit: bytesToBase64(c.data),
      })),
      ...hides.map((h): SyncItem => ({
        type: 'hidden',
        version: Number(h.version),
        messageId: h.messageId,
      })),
      ...eventViews.map((e): SyncItem => ({ type: 'event', version: e.version, event: e.view })),
    ].sort((a, b) => a.version - b.version);

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return { items: page, version: hasMore && last ? last.version : Number(upTo), hasMore };
  }

  /** Renders timeline events; actor and subject are shown by OGC ID only. */
  private async eventViews(
    rows: {
      id: string;
      version: bigint;
      type: ConversationEventView['type'];
      actorId: string | null;
      subjectId: string | null;
      detail: Prisma.JsonValue;
      createdAt: Date;
    }[],
  ): Promise<{ version: number; view: ConversationEventView }[]> {
    if (rows.length === 0) return [];
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.actorId, r.subjectId]).filter((id) => id !== null)),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, ogcId: true },
    });
    const ogcIds = new Map(users.map((u) => [u.id, u.ogcId as OgcId]));
    return rows.map((r) => ({
      version: Number(r.version),
      view: {
        id: r.id,
        type: r.type,
        actor: r.actorId ? (ogcIds.get(r.actorId) ?? null) : null,
        subject: r.subjectId ? (ogcIds.get(r.subjectId) ?? null) : null,
        detail:
          r.detail !== null && typeof r.detail === 'object' && !Array.isArray(r.detail)
            ? (r.detail as Record<string, unknown>)
            : null,
        createdAt: r.createdAt.toISOString(),
      },
    }));
  }

  /** Message history by position, newest page first (`before`) or forwards (`after`). */
  async history(
    auth: AuthContext,
    conversationId: string,
    query: { before?: number | undefined; after?: number | undefined; limit: number },
  ): Promise<MessagePage> {
    const access = await this.access.require(auth.userId, conversationId);
    const forward = query.after !== undefined;
    const lower =
      query.after !== undefined && BigInt(query.after) > access.visibleFrom
        ? BigInt(query.after)
        : access.visibleFrom;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...visibleTo(auth.userId),
        seq: {
          gt: lower,
          ...(query.before !== undefined ? { lt: BigInt(query.before) } : {}),
        },
      },
      orderBy: { seq: forward ? 'asc' : 'desc' },
      take: query.limit + 1,
      select: MESSAGE_SELECT,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (!forward) page.reverse();
    const hidden = blockedBy(access, auth.userId);
    return { items: page.map((r) => toMessageView(r, hidden)), hasMore };
  }

  /**
   * Emits a message change to every participant allowed to see it (a withheld
   * message only to its sender), hiding reactions by people each viewer blocked.
   */
  private publishMessage(
    event: 'message.created' | 'message.updated' | 'message.deleted',
    row: MessageRow,
    actorId: string,
    access: ParticipantAccess,
  ): void {
    const audience = access.members
      .map((m) => m.userId)
      .filter((id) => !row.withheld || id === row.senderId || id === actorId);
    for (const { userIds, hidden } of viewerGroups(access, audience)) {
      this.realtime.toUsers(userIds, event, { message: toMessageView(row, hidden) });
    }
  }
}

/** Groups viewers by the set of people they blocked, so each distinct view is rendered once. */
function viewerGroups(
  access: ParticipantAccess,
  userIds: string[],
): { userIds: string[]; hidden: Set<string> }[] {
  const groups = new Map<string, { userIds: string[]; hidden: Set<string> }>();
  for (const userId of new Set(userIds)) {
    const hidden = blockedBy(access, userId);
    const key = [...hidden].sort().join(',');
    const group = groups.get(key) ?? { userIds: [], hidden };
    group.userIds.push(userId);
    groups.set(key, group);
  }
  return [...groups.values()];
}
