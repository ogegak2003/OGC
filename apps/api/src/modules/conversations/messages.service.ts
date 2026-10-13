import { HttpStatus, Injectable } from '@nestjs/common';
import { editAad, equalBytes, inspectApplicationMessage, messageAad } from '@ogc/e2ee';
import type { MessagePage, MessageView, ReactionType, SyncItem, SyncPage } from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { DeviceKeysService, invalidMls } from '../e2ee/device-keys.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import {
  ConversationAccessService,
  type ParticipantAccess,
  messageNotFound,
} from './conversation-access.service.js';
import { nextVersion, staleEpoch } from './conversation-version.js';
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
 * The message lifecycle (ADR-022/025): CREATED on the device → SENT when this
 * service has persisted it (the API response) → DELIVERED / READ through
 * per-participant high-water marks. Realtime events are emitted only after the
 * database transaction commits; sync recovers anything a socket missed.
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
      return toMessageView(replay);
    }

    this.access.assertCanSend(access);
    checkCiphertext(
      input.ciphertext,
      conversationId,
      input.epoch,
      messageAad(conversationId, input.clientMessageId),
    );

    let row: MessageRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const { version, mlsEpoch } = await nextVersion(tx, conversationId, { activity: true });
        if (mlsEpoch !== BigInt(input.epoch)) throw staleEpoch();

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
            withheld: access.blockedByPeer,
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
        if (existing?.conversationId === conversationId) return toMessageView(existing);
      }
      if (error instanceof ApiException) {
        this.metrics.failures.inc({ operation: 'send', reason: String(error.getStatus()) });
      }
      throw error;
    }

    this.metrics.messagesSent.inc();
    const recipients = row.withheld ? [] : [access.peerId];
    this.publishMessage('message.created', row, auth.userId, access);
    this.events.publish({
      type: 'message.created',
      conversationId,
      messageId: row.id,
      senderId: auth.userId,
      recipientIds: recipients,
    });
    return toMessageView(row, access.blockedByViewer ? new Set([access.peerId]) : new Set());
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
    return { row, access: await this.access.require(userId, row.conversationId) };
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
    const revision = row.revision + 1;
    checkCiphertext(
      input.ciphertext,
      row.conversationId,
      input.epoch,
      editAad(row.conversationId, row.clientMessageId, revision),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const { version, mlsEpoch } = await nextVersion(tx, row.conversationId);
      if (mlsEpoch !== BigInt(input.epoch)) throw staleEpoch();
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
    return toMessageView(updated);
  }

  /**
   * "Delete for everyone" removes the ciphertext, reactions and attachment
   * blobs from the server and tells every device to erase its local copy.
   * It cannot reach copies already exported, screenshotted or backed up.
   * Metadata (that a message existed and was deleted) is kept.
   */
  async deleteForEveryone(auth: AuthContext, messageId: string, meta: RequestMeta): Promise<void> {
    const { row, access } = await this.loadForViewer(auth.userId, messageId);
    if (row.senderId !== auth.userId)
      throw forbidden('You can only delete your own messages for everyone');
    if (row.deletedAt) return;
    if (Date.now() - row.createdAt.getTime() > MESSAGE_DELETE_FOR_EVERYONE_WINDOW_MS) {
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
        await this.audit.record(
          {
            type: 'MESSAGE_DELETED_FOR_EVERYONE',
            userId: auth.userId,
            sessionId: auth.sessionId,
            meta,
            details: { conversationId: row.conversationId, messageId },
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
    if (add) this.access.assertCanSend(access);

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
    const payload = (hidden: ReadonlySet<string>) => {
      const view = toMessageView(updated, hidden);
      return {
        conversationId: view.conversationId,
        messageId: view.id,
        version: view.version,
        reactions: view.reactions,
      };
    };
    this.realtime.toUsers(
      [auth.userId],
      'message.reaction',
      payload(access.blockedByViewer ? new Set([access.peerId]) : new Set()),
    );
    if (
      !access.blockedByPeer &&
      !access.blockedByViewer &&
      !(updated.withheld && updated.senderId !== access.peerId)
    ) {
      this.realtime.toUsers([access.peerId], 'message.reaction', payload(new Set()));
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
          senderId: access.peerId,
        },
        orderBy: { seq: 'desc' },
        select: { createdAt: true },
      });
      if (newest)
        this.metrics.deliveryLatency.observe((now.getTime() - newest.createdAt.getTime()) / 1000);
    }
    const payload = { conversationId, ogcId: auth.ogcId, seq: Number(seq) };
    const event = kind === 'read' ? 'message.read' : 'message.delivered';
    // The caller's other devices always learn it (unread counts); the peer only without a block.
    const audience =
      access.blockedByViewer || access.blockedByPeer ? [auth.userId] : [auth.userId, access.peerId];
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
   * messages, MLS commits (needed to keep decrypting) and the caller's own
   * "delete for me" hides. Reading the conversation version first gives a
   * consistent snapshot: every version up to it has committed.
   */
  async sync(
    auth: AuthContext,
    conversationId: string,
    after: number,
    limit: number,
  ): Promise<SyncPage> {
    const access = await this.access.require(auth.userId, conversationId);
    const upTo = access.version;
    const from = BigInt(after);
    if (from >= upTo) return { items: [], version: Number(upTo), hasMore: false };

    const range = { gt: from, lte: upTo };
    const [messages, commits, hides] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId, version: range, ...visibleTo(auth.userId) },
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
    ]);
    const hidden = access.blockedByViewer ? new Set([access.peerId]) : new Set<string>();
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
    ].sort((a, b) => a.version - b.version);

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return { items: page, version: hasMore && last ? last.version : Number(upTo), hasMore };
  }

  /** Message history by position, newest page first (`before`) or forwards (`after`). */
  async history(
    auth: AuthContext,
    conversationId: string,
    query: { before?: number | undefined; after?: number | undefined; limit: number },
  ): Promise<MessagePage> {
    const access = await this.access.require(auth.userId, conversationId);
    const forward = query.after !== undefined;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...visibleTo(auth.userId),
        ...(query.before !== undefined ? { seq: { lt: BigInt(query.before) } } : {}),
        ...(query.after !== undefined ? { seq: { gt: BigInt(query.after) } } : {}),
      },
      orderBy: { seq: forward ? 'asc' : 'desc' },
      take: query.limit + 1,
      select: MESSAGE_SELECT,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (!forward) page.reverse();
    const hidden = access.blockedByViewer ? new Set([access.peerId]) : new Set<string>();
    return { items: page.map((r) => toMessageView(r, hidden)), hasMore };
  }

  /** Emits a message change to the sender's devices and, unless withheld, to the peer. */
  private publishMessage(
    event: 'message.created' | 'message.updated' | 'message.deleted',
    row: MessageRow,
    actorId: string,
    access: ParticipantAccess,
  ): void {
    this.realtime.toUsers([actorId], event, {
      message: toMessageView(row, access.blockedByViewer ? new Set([access.peerId]) : new Set()),
    });
    if (!row.withheld) {
      this.realtime.toUsers([access.peerId], event, {
        message: toMessageView(row, access.blockedByPeer ? new Set([actorId]) : new Set()),
      });
    }
  }
}
