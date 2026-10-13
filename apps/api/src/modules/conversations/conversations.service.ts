import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  ConversationChanges,
  ConversationView,
  DirectoryDevice,
  OgcId,
  Page,
} from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import { AuditService } from '../audit/audit.service.js';
import { DeviceKeysService } from '../e2ee/device-keys.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { ConversationAccessService } from './conversation-access.service.js';
import { CHANGE_FEED_SAFETY_LAG_MS, UNREAD_COUNT_CAP } from './messaging.constants.js';

const CONVERSATION_SELECT = {
  id: true,
  type: true,
  version: true,
  mlsEpoch: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
  participants: {
    select: {
      userId: true,
      lastReadSeq: true,
      lastDeliveredSeq: true,
      user: {
        select: {
          ogcId: true,
          profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
        },
      },
    },
  },
} as const;

interface ConversationRow {
  id: string;
  version: bigint;
  mlsEpoch: bigint;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
  participants: {
    userId: string;
    lastReadSeq: bigint;
    lastDeliveredSeq: bigint;
    user: {
      ogcId: string;
      profile: {
        displayName: string;
        avatarKey: string | null;
        profileVisibility: 'EVERYONE' | 'CONTACTS';
      } | null;
    };
  }[];
}

function encodeKeyset(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeKeyset(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'cursor: Invalid cursor');
  }
  return { at, id };
}

/**
 * DIRECT conversations (ADR-022): creation, listing and change feeds. Content
 * is never visible here — list previews are decrypted on the device.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relationships: RelationshipService,
    private readonly access: ConversationAccessService,
    private readonly devices: DeviceKeysService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimePublisher,
  ) {}

  /**
   * Opens the DIRECT conversation with a contact, creating it on first use.
   * Exactly one conversation can exist per pair (unique `direct_key`), even
   * when both people start it at the same moment.
   */
  async openDirect(
    viewerId: string,
    ogcId: OgcId,
    meta: RequestMeta,
  ): Promise<{ conversation: ConversationView; created: boolean }> {
    const { target, state } = await this.relationships.resolveVisible(viewerId, ogcId);
    if (state.relationship === 'SELF') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'You cannot message yourself',
      );
    }
    if (state.blockedByViewer) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'BLOCKED',
        'Unblock this person to message them',
      );
    }
    const directKey = [viewerId, target.userId].sort().join(':');
    const existing = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: { id: true },
    });
    if (existing) return { conversation: await this.view(viewerId, existing.id), created: false };

    if (!state.isContact) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'NOT_A_CONTACT',
        'You can start conversations with your contacts',
      );
    }
    const id = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.conversation.create({
          data: {
            id,
            type: 'DIRECT',
            directKey,
            createdById: viewerId,
            participants: { create: [{ userId: viewerId }, { userId: target.userId }] },
          },
        });
        await this.audit.record({ type: 'CONVERSATION_CREATED', userId: viewerId, meta }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'direct_key')) {
        const winner = await this.prisma.conversation.findUniqueOrThrow({
          where: { directKey },
          select: { id: true },
        });
        return { conversation: await this.view(viewerId, winner.id), created: false };
      }
      throw error;
    }
    const [mine, theirs] = await Promise.all([
      this.view(viewerId, id),
      this.view(target.userId, id),
    ]);
    this.realtime.toUsers([viewerId], 'conversation.created', { conversation: mine });
    this.realtime.toUsers([target.userId], 'conversation.created', { conversation: theirs });
    return { conversation: mine, created: true };
  }

  async view(viewerId: string, conversationId: string): Promise<ConversationView> {
    await this.access.require(viewerId, conversationId);
    const row = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: CONVERSATION_SELECT,
    });
    const [view] = await this.toViews(viewerId, [row]);
    if (!view) throw new Error('Conversation view missing');
    return view;
  }

  /** Conversations by most recent activity (keyset pagination). */
  async list(
    viewerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<ConversationView>> {
    const after = decodeKeyset(cursor);
    const rows = await this.prisma.conversation.findMany({
      where: {
        participants: { some: { userId: viewerId } },
        ...(after
          ? {
              OR: [
                { lastActivityAt: { lt: after.at } },
                { lastActivityAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: CONVERSATION_SELECT,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await this.toViews(viewerId, page),
      nextCursor: rows.length > limit && last ? encodeKeyset(last.lastActivityAt, last.id) : null,
    };
  }

  /**
   * Conversations changed since a cursor, oldest change first — used by a
   * reconnecting or new device to find which conversations to sync.
   */
  async changes(
    viewerId: string,
    since: string | undefined,
    limit: number,
  ): Promise<ConversationChanges> {
    const after = decodeKeyset(since);
    const rows = await this.prisma.conversation.findMany({
      where: {
        participants: { some: { userId: viewerId } },
        ...(after
          ? { OR: [{ updatedAt: { gt: after.at } }, { updatedAt: after.at, id: { gt: after.id } }] }
          : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: CONVERSATION_SELECT,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    // At the frontier, stay a little behind "now" so changes that commit late with an earlier
    // timestamp are not skipped; re-sent conversations are harmless (clients compare versions).
    const safe = new Date(Date.now() - CHANGE_FEED_SAFETY_LAG_MS);
    const cursor =
      last && (hasMore || last.updatedAt < safe)
        ? encodeKeyset(last.updatedAt, last.id)
        : encodeKeyset(safe, '00000000-0000-0000-0000-000000000000');
    return { items: await this.toViews(viewerId, page), cursor, hasMore };
  }

  /** The encryption directory for a conversation: the devices of both participants. */
  async directory(viewerId: string, conversationId: string): Promise<DirectoryDevice[]> {
    const access = await this.access.require(viewerId, conversationId);
    return this.devices.directory([viewerId, access.peerId]);
  }

  /** Builds views for a page of conversations with a fixed number of queries. */
  private async toViews(viewerId: string, rows: ConversationRow[]): Promise<ConversationView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const peerIds = rows.flatMap((r) =>
      r.participants.filter((p) => p.userId !== viewerId).map((p) => p.userId),
    );

    const [unread, lastMessages, contacts, blocks] = await Promise.all([
      this.prisma.$queryRaw<{ conversation_id: string; unread: number }[]>`
        SELECT p.conversation_id, (
          SELECT count(*)::int FROM (
            SELECT 1 FROM "messages" m
            WHERE m.conversation_id = p.conversation_id
              AND m.seq > p.last_read_seq
              AND m.sender_id IS DISTINCT FROM ${viewerId}::uuid
              AND m.deleted_at IS NULL
              AND m.withheld = false
              AND NOT EXISTS (SELECT 1 FROM "message_hides" h WHERE h.user_id = ${viewerId}::uuid AND h.message_id = m.id)
            LIMIT ${UNREAD_COUNT_CAP}
          ) x
        ) AS unread
        FROM "conversation_participants" p
        WHERE p.user_id = ${viewerId}::uuid AND p.conversation_id = ANY(${ids}::uuid[])`,
      this.prisma.$queryRaw<
        {
          conversation_id: string;
          id: string;
          seq: bigint;
          created_at: Date;
          deleted_at: Date | null;
          ogc_id: string | null;
        }[]
      >`
        SELECT c.id AS conversation_id, lm.id, lm.seq, lm.created_at, lm.deleted_at, lm.ogc_id
        FROM unnest(${ids}::uuid[]) AS c(id)
        CROSS JOIN LATERAL (
          SELECT m.id, m.seq, m.created_at, m.deleted_at, u.ogc_id
          FROM "messages" m LEFT JOIN "users" u ON u.id = m.sender_id
          WHERE m.conversation_id = c.id
            AND (m.withheld = false OR m.sender_id = ${viewerId}::uuid)
            AND NOT EXISTS (SELECT 1 FROM "message_hides" h WHERE h.user_id = ${viewerId}::uuid AND h.message_id = m.id)
          ORDER BY m.seq DESC
          LIMIT 1
        ) lm`,
      this.prisma.contact.findMany({
        where: { ownerId: viewerId, contactId: { in: peerIds } },
        select: { contactId: true },
      }),
      this.prisma.block.findMany({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: { in: peerIds } },
            { blockerId: { in: peerIds }, blockedId: viewerId },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
    ]);
    const unreadBy = new Map(unread.map((u) => [u.conversation_id, u.unread]));
    const lastBy = new Map(lastMessages.map((m) => [m.conversation_id, m]));
    const contactSet = new Set(contacts.map((c) => c.contactId));
    const blockedByMe = new Set(
      blocks.filter((b) => b.blockerId === viewerId).map((b) => b.blockedId),
    );
    const blockedMe = new Set(
      blocks.filter((b) => b.blockedId === viewerId).map((b) => b.blockerId),
    );

    return rows.flatMap((row) => {
      const me = row.participants.find((p) => p.userId === viewerId);
      const peer = row.participants.find((p) => p.userId !== viewerId);
      if (!me || !peer) return [];
      const blocked = blockedByMe.has(peer.userId) || blockedMe.has(peer.userId);
      const detailsVisible =
        !blocked &&
        (contactSet.has(peer.userId) || peer.user.profile?.profileVisibility === 'EVERYONE');
      const last = lastBy.get(row.id);
      return [
        {
          id: row.id,
          type: 'DIRECT' as const,
          peer: this.relationships.summary(peer.user, detailsVisible),
          version: Number(row.version),
          lastActivityAt: row.lastActivityAt.toISOString(),
          lastMessage: last
            ? {
                id: last.id,
                seq: Number(last.seq),
                senderOgcId: last.ogc_id as OgcId | null,
                createdAt: last.created_at.toISOString(),
                deleted: last.deleted_at !== null,
              }
            : null,
          unreadCount: unreadBy.get(row.id) ?? 0,
          myLastReadSeq: Number(me.lastReadSeq),
          // Receipts are not shared across a block in either direction.
          peerLastReadSeq: blocked ? 0 : Number(peer.lastReadSeq),
          peerLastDeliveredSeq: blocked ? 0 : Number(peer.lastDeliveredSeq),
          blockedByMe: blockedByMe.has(peer.userId),
          mls: { epoch: Number(row.mlsEpoch), ready: row.mlsEpoch > 0n },
          createdAt: row.createdAt.toISOString(),
        },
      ];
    });
  }
}
