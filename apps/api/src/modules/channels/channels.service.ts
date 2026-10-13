import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type {
  ChannelMemberView,
  ChannelView,
  JoinResult,
  NotificationPreferences,
  OgcId,
  Page,
  VisibilityChangeResult,
} from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import { blankToNull } from '../../common/text.js';
import { decodeCursor, encodeCursor } from '../../common/pagination.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import type {
  ChannelJoinPolicy,
  ChannelMemberStatus,
  PostPolicy,
  Prisma,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  canArchiveOrDelete,
  canAssignRole,
  canChangePolicies,
  canEditDetails,
  canModerate,
  canTransferOwnership,
} from '../community/community-permissions.js';
import { CommunityNotificationsService } from '../notifications/community-notifications.service.js';
import { processAvatar } from '../profiles/avatar-image.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import {
  CHANNEL_SELECT,
  type ChannelAccess,
  ChannelAccessService,
  MEMBERSHIP_SELECT,
  type MembershipRow,
  channelForbidden,
  channelNotFound,
} from './channel-access.service.js';
import { lockChannel, nextChannelVersion } from './channel-version.js';
import { toChannelView } from './channel-views.js';

const UNREAD_CAP = 1000;
const MODERATOR_FANOUT_MAX = 50;
const MY_CHANNELS_MAX = 500;

const memberNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Member not found');

export interface CreateChannelInput {
  handle: string;
  name: string;
  description?: string | undefined;
  visibility: 'PUBLIC' | 'PRIVATE';
  joinPolicy: ChannelJoinPolicy;
  postPolicy: PostPolicy;
  repliesEnabled: boolean;
}

export interface UpdateChannelInput {
  name?: string | undefined;
  description?: string | null | undefined;
  joinPolicy?: ChannelJoinPolicy | undefined;
  postPolicy?: PostPolicy | undefined;
  repliesEnabled?: boolean | undefined;
}

function encodeDiscoveryCursor(memberCount: number, id: string): string {
  return encodeCursor(`${String(memberCount)}|${id}`);
}

function decodeDiscoveryCursor(
  cursor: string | undefined,
): { count: number; id: string } | undefined {
  if (!cursor) return undefined;
  const [count, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const parsed = Number(count);
  if (!id || !Number.isSafeInteger(parsed) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'cursor: Invalid cursor');
  }
  return { count: parsed, id };
}

/**
 * Community channels (ADR-032): server-readable, built for larger audiences,
 * discovery and moderation — never presented as end-to-end encrypted. Public
 * channels can be found and read by any signed-in account; private channels
 * only by members (joined through an invitation link). Changing visibility
 * requires the owner's explicit confirmation; encryption mode never changes.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly relationships: RelationshipService,
    private readonly notifications: CommunityNotificationsService,
    private readonly realtime: RealtimePublisher,
    private readonly events: DomainEventBus,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
  ) {}

  // -------------------------------------------------------------------------
  // Creation, views, discovery
  // -------------------------------------------------------------------------

  async create(
    auth: AuthContext,
    input: CreateChannelInput,
    meta: RequestMeta,
  ): Promise<ChannelView> {
    const id = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.channel.create({
          data: {
            id,
            handle: input.handle,
            name: input.name,
            description: blankToNull(input.description),
            visibility: input.visibility,
            joinPolicy: input.joinPolicy,
            postPolicy: input.postPolicy,
            repliesEnabled: input.repliesEnabled,
            memberCount: 1,
            createdById: auth.userId,
            members: { create: { userId: auth.userId, role: 'OWNER', status: 'ACTIVE' } },
          },
        });
        await this.audit.record(
          {
            type: 'CHANNEL_CREATED',
            userId: auth.userId,
            sessionId: auth.sessionId,
            meta,
            details: { channelId: id, visibility: input.visibility },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, 'handle')) {
        throw new ApiException(HttpStatus.CONFLICT, 'HANDLE_TAKEN', 'That handle is already taken');
      }
      throw error;
    }
    this.events.publish({ type: 'membership.changed', channelId: id, userIds: [auth.userId] });
    const view = await this.view(auth.userId, id);
    this.realtime.toUsers([auth.userId], 'channel.created', { channel: view });
    return view;
  }

  async view(viewerId: string, channelId: string): Promise<ChannelView> {
    const access = await this.access.requireReadable(viewerId, channelId);
    const unread = await this.unreadCounts(viewerId, [access]);
    return toChannelView(access.channel, access.membership, unread.get(channelId) ?? 0);
  }

  async byHandle(viewerId: string, handle: string): Promise<ChannelView> {
    const channel = await this.prisma.channel.findUnique({
      where: { handle },
      select: { id: true },
    });
    if (!channel) throw channelNotFound();
    return this.view(viewerId, channel.id);
  }

  private async unreadCounts(
    viewerId: string,
    accesses: ChannelAccess[],
  ): Promise<Map<string, number>> {
    const ids = accesses.filter((a) => a.active).map((a) => a.channel.id);
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ channel_id: string; unread: number }[]>`
      SELECT m.channel_id, (
        SELECT count(*)::int FROM (
          SELECT 1 FROM "channel_posts" p
          WHERE p.channel_id = m.channel_id
            AND p.seq > m.last_read_seq
            AND p.author_id IS DISTINCT FROM ${viewerId}::uuid
            AND p.deleted_at IS NULL AND p.removed_at IS NULL
          LIMIT ${UNREAD_CAP}
        ) x
      ) AS unread
      FROM "channel_members" m
      WHERE m.user_id = ${viewerId}::uuid AND m.status = 'ACTIVE' AND m.channel_id = ANY(${ids}::uuid[])`;
    return new Map(rows.map((r) => [r.channel_id, r.unread]));
  }

  /** The caller's channels (active memberships and pending requests), most recent posts first. */
  async mine(viewerId: string): Promise<ChannelView[]> {
    const rows = await this.prisma.channelMember.findMany({
      where: { userId: viewerId, status: { in: ['ACTIVE', 'PENDING'] } },
      take: MY_CHANNELS_MAX,
      orderBy: [{ channel: { lastPostAt: { sort: 'desc', nulls: 'last' } } }, { channelId: 'asc' }],
      select: { ...MEMBERSHIP_SELECT, channel: { select: CHANNEL_SELECT } },
    });
    const accesses: ChannelAccess[] = rows.map(({ channel, ...membership }) => ({
      channel,
      viewerId,
      membership,
      active: membership.status === 'ACTIVE',
      role: membership.status === 'ACTIVE' ? membership.role : null,
    }));
    const unread = await this.unreadCounts(viewerId, accesses);
    return accesses.map((a) =>
      toChannelView(a.channel, a.membership, unread.get(a.channel.id) ?? 0),
    );
  }

  /**
   * Public, non-archived channels only, by size. With `q` (≥ 2 characters),
   * matches name, handle and description (trigram index). Private channels are
   * never listed or matched.
   */
  async discover(
    viewerId: string,
    query: { q?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<Page<ChannelView>> {
    const after = decodeDiscoveryCursor(query.cursor);
    const q = query.q?.trim().toLowerCase() ?? '';
    if (q.length === 1) return { items: [], nextCursor: null };
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.prisma.$queryRaw<{ id: string; member_count: number }[]>`
      SELECT c.id, c.member_count FROM "channels" c
      WHERE c.visibility = 'PUBLIC' AND c.archived_at IS NULL
        AND (${q} = '' OR lower(c.name || ' ' || c.handle || ' ' || coalesce(c.description, '')) LIKE ${pattern})
        AND (${after === undefined} OR (c.member_count, c.id) < (${after?.count ?? 0}, ${after?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
      ORDER BY c.member_count DESC, c.id DESC
      LIMIT ${query.limit + 1}`;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const accesses = (await Promise.all(page.map((r) => this.access.load(viewerId, r.id)))).filter(
      (a): a is ChannelAccess => a !== undefined && this.access.canRead(a),
    );
    const unread = await this.unreadCounts(viewerId, accesses);
    return {
      items: accesses.map((a) =>
        toChannelView(a.channel, a.membership, unread.get(a.channel.id) ?? 0),
      ),
      nextCursor:
        rows.length > query.limit && last
          ? encodeDiscoveryCursor(last.member_count, last.id)
          : null,
    };
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async update(
    auth: AuthContext,
    channelId: string,
    input: UpdateChannelInput,
  ): Promise<ChannelView> {
    const access = await this.access.requireMember(auth.userId, channelId);
    this.access.assertWritable(access);
    const role = access.role ?? 'MEMBER';
    const details = input.name !== undefined || input.description !== undefined;
    const policies =
      input.joinPolicy !== undefined ||
      input.postPolicy !== undefined ||
      input.repliesEnabled !== undefined;
    if ((details && !canEditDetails(role)) || (policies && !canChangePolicies(role))) {
      throw channelForbidden();
    }
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await nextChannelVersion(tx, channelId);
      await tx.channel.update({
        where: { id: channelId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: blankToNull(input.description) }
            : {}),
          ...(input.joinPolicy !== undefined ? { joinPolicy: input.joinPolicy } : {}),
          ...(input.postPolicy !== undefined ? { postPolicy: input.postPolicy } : {}),
          ...(input.repliesEnabled !== undefined ? { repliesEnabled: input.repliesEnabled } : {}),
        },
      });
      return v;
    });
    this.realtime.toChannel(channelId, 'channel.updated', { channelId, version: Number(version) });
    return this.view(auth.userId, channelId);
  }

  /**
   * Public ⇄ private. The owner must confirm (`confirm: true`) after seeing the
   * consequences; content stays server-readable either way — this never turns
   * a community channel into an end-to-end encrypted one.
   */
  async changeVisibility(
    auth: AuthContext,
    channelId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    meta: RequestMeta,
  ): Promise<VisibilityChangeResult> {
    const access = await this.access.requireMember(auth.userId, channelId);
    if (access.role !== 'OWNER') throw channelForbidden('Only the owner can change visibility');
    this.access.assertWritable(access);
    const consequences =
      visibility === 'PRIVATE'
        ? [
            'The channel disappears from discovery and search.',
            'Only current members can read it; new people can join only with an invitation link.',
            'Posts stay readable by OGC (community channels are not end-to-end encrypted).',
          ]
        : [
            'Anyone on OGC can find the channel and read all of its posts, including older ones.',
            'People can join according to the join policy.',
            'Posts stay readable by OGC (community channels are not end-to-end encrypted).',
          ];
    if (access.channel.visibility !== visibility) {
      const version = await this.prisma.$transaction(async (tx) => {
        const v = await nextChannelVersion(tx, channelId);
        await tx.channel.update({ where: { id: channelId }, data: { visibility } });
        await tx.channelModerationAction.create({
          data: {
            channelId,
            moderatorId: auth.userId,
            action: 'VISIBILITY_CHANGED',
            reason: visibility,
          },
        });
        await this.audit.record(
          {
            type: 'CHANNEL_VISIBILITY_CHANGED',
            userId: auth.userId,
            sessionId: auth.sessionId,
            meta,
            details: { channelId, visibility },
          },
          tx,
        );
        return v;
      });
      this.realtime.toChannel(channelId, 'channel.updated', {
        channelId,
        version: Number(version),
      });
    }
    return { channel: await this.view(auth.userId, channelId), consequences };
  }

  async setAvatar(auth: AuthContext, channelId: string, upload: Buffer): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    this.access.assertWritable(access);
    if (!access.role || !canEditDetails(access.role)) throw channelForbidden();
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
        const v = await nextChannelVersion(tx, channelId);
        const current = await tx.channel.findUniqueOrThrow({
          where: { id: channelId },
          select: { avatarKey: true },
        });
        await tx.channel.update({ where: { id: channelId }, data: { avatarKey: key } });
        return { previous: current.avatarKey, version: v };
      }));
    } catch (error) {
      await this.storage.delete(key);
      throw error;
    }
    if (previous) await this.removeObject(previous);
    this.realtime.toChannel(channelId, 'channel.updated', { channelId, version: Number(version) });
  }

  async removeAvatar(auth: AuthContext, channelId: string): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    this.access.assertWritable(access);
    if (!access.role || !canEditDetails(access.role)) throw channelForbidden();
    if (!access.channel.avatarKey) return;
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await nextChannelVersion(tx, channelId);
      await tx.channel.update({ where: { id: channelId }, data: { avatarKey: null } });
      return v;
    });
    await this.removeObject(access.channel.avatarKey);
    this.realtime.toChannel(channelId, 'channel.updated', { channelId, version: Number(version) });
  }

  async avatar(viewerId: string, channelId: string): Promise<Buffer> {
    const access = await this.access.requireReadable(viewerId, channelId);
    const data = access.channel.avatarKey
      ? await this.storage.get(access.channel.avatarKey)
      : undefined;
    if (!data) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No photo');
    return data;
  }

  private async removeObject(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn({ err: error }, 'Stored object cleanup failed');
    }
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /** Joins a public channel (OPEN → member; APPROVAL → pending request). */
  async join(auth: AuthContext, channelId: string): Promise<JoinResult> {
    const status = await this.addMember(auth.userId, channelId, { viaLink: false });
    return { target: 'COMMUNITY_CHANNEL', id: channelId, status };
  }

  /**
   * Adds a member under the channel lock. Idempotent for existing members.
   * Banned accounts are refused (also through invitation links); private
   * channels require `viaLink`. The approval policy always applies.
   */
  async addMember(
    userId: string,
    channelId: string,
    options: { viaLink: boolean; extra?: (tx: Prisma.TransactionClient) => Promise<void> },
  ): Promise<'JOINED' | 'PENDING'> {
    const result = await this.prisma.$transaction(async (tx) => {
      if (!(await lockChannel(tx, channelId))) throw channelNotFound();
      const [channel, existing] = await Promise.all([
        tx.channel.findUniqueOrThrow({
          where: { id: channelId },
          select: { visibility: true, joinPolicy: true, archivedAt: true, version: true },
        }),
        tx.channelMember.findUnique({
          where: { channelId_userId: { channelId, userId } },
          select: { status: true },
        }),
      ]);
      if (!options.viaLink && channel.visibility === 'PRIVATE' && existing?.status !== 'ACTIVE') {
        throw channelNotFound();
      }
      if (existing?.status === 'ACTIVE') return { status: 'JOINED' as const, changed: false };
      if (existing?.status === 'PENDING') return { status: 'PENDING' as const, changed: false };
      if (existing?.status === 'BANNED') throw channelForbidden('You can’t join this channel');
      if (channel.archivedAt) throw channelForbidden('This channel is archived');
      if (options.extra) await options.extra(tx);
      const status: ChannelMemberStatus = channel.joinPolicy === 'APPROVAL' ? 'PENDING' : 'ACTIVE';
      await tx.channelMember.create({
        data: { channelId, userId, role: 'MEMBER', status, lastReadSeq: channel.version },
      });
      if (status === 'ACTIVE') {
        await tx.channel.update({
          where: { id: channelId },
          data: { memberCount: { increment: 1 } },
        });
      }
      return {
        status: status === 'ACTIVE' ? ('JOINED' as const) : ('PENDING' as const),
        changed: true,
      };
    });
    if (!result.changed) return result.status;
    const ogcId = await this.ogcIdOf(userId);
    if (result.status === 'JOINED') {
      this.events.publish({ type: 'membership.changed', channelId, userIds: [userId] });
      this.realtime.toUsers(
        [userId, ...(await this.moderatorIds(channelId))],
        'channel.member_joined',
        { channelId, ogcId },
      );
    } else {
      const moderators = await this.moderatorIds(channelId);
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        select: { name: true },
      });
      await this.notifications.notify(
        moderators.map((id) => ({
          userId: id,
          type: 'CHANNEL_JOIN_REQUEST' as const,
          dedupeKey: `channel-request:${channelId}:${userId}:${String(Date.now())}`,
          data: { channelId, channelName: channel?.name ?? '', ogcId },
        })),
      );
    }
    return result.status;
  }

  async moderatorIds(channelId: string): Promise<string[]> {
    const rows = await this.prisma.channelMember.findMany({
      where: { channelId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN', 'MODERATOR'] } },
      take: MODERATOR_FANOUT_MAX,
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Leaves (or withdraws a join request). The owner must transfer ownership first. */
  async leave(auth: AuthContext, channelId: string): Promise<void> {
    const access = await this.access.load(auth.userId, channelId);
    if (!access?.membership || access.membership.status === 'BANNED') throw channelNotFound();
    if (access.membership.role === 'OWNER') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'Transfer ownership before leaving, or delete the channel',
      );
    }
    await this.removeMembership(channelId, auth.userId);
    this.realtime.toUsers(
      [auth.userId, ...(await this.moderatorIds(channelId))],
      'channel.member_left',
      { channelId, ogcId: auth.ogcId },
    );
  }

  /**
   * Deletes a non-owner, non-banned membership row (keeping the member count
   * right) and, when it owns the transaction, stops the person's realtime
   * channel events. Returns the removed status, or undefined if there was
   * nothing to remove.
   */
  async removeMembership(
    channelId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ChannelMemberStatus | undefined> {
    const run = async (client: Prisma.TransactionClient) => {
      if (!(await lockChannel(client, channelId))) throw channelNotFound();
      const row = await client.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId } },
        select: { status: true, role: true },
      });
      if (!row || row.role === 'OWNER' || row.status === 'BANNED') return undefined;
      await client.channelMember.delete({ where: { channelId_userId: { channelId, userId } } });
      if (row.status === 'ACTIVE') {
        await client.channel.update({
          where: { id: channelId },
          data: { memberCount: { decrement: 1 } },
        });
      }
      return row.status;
    };
    if (tx) return run(tx); // The caller updates realtime rooms after committing.
    const removed = await this.prisma.$transaction(run);
    if (removed) this.events.publish({ type: 'membership.changed', channelId, userIds: [userId] });
    return removed;
  }

  /**
   * Member directory. Moderators see everyone (including pending requests and
   * bans); other members see the owner, administrators and moderators only.
   */
  async members(
    viewerId: string,
    channelId: string,
    query: { status?: ChannelMemberStatus | undefined; cursor?: string | undefined; limit: number },
  ): Promise<Page<ChannelMemberView>> {
    const access = await this.access.requireMember(viewerId, channelId);
    const moderator = access.role !== null && canModerate(access.role);
    const after = decodeCursor(query.cursor);
    const rows = await this.prisma.channelMember.findMany({
      where: {
        channelId,
        status: moderator ? (query.status ?? 'ACTIVE') : 'ACTIVE',
        ...(moderator ? {} : { role: { in: ['OWNER', 'ADMIN', 'MODERATOR'] } }),
        ...(after ? { userId: { gt: after } } : {}),
      },
      orderBy: { userId: 'asc' },
      take: query.limit + 1,
      select: {
        role: true,
        status: true,
        suspendedUntil: true,
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
    const page = rows.slice(0, query.limit);
    const summaries = await this.relationships.summariesFor(
      viewerId,
      page.map((r) => r.user),
    );
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        profile: summaries.get(r.user.id) ?? this.relationships.summary(r.user, false),
        role: r.role,
        status: r.status,
        suspendedUntil: r.suspendedUntil?.toISOString() ?? null,
        joinedAt: r.joinedAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.user.id) : null,
    };
  }

  async memberByOgcId(
    channelId: string,
    ogcId: OgcId,
  ): Promise<{ userId: string } & MembershipRow> {
    const row = await this.prisma.channelMember.findFirst({
      where: { channelId, user: { ogcId } },
      select: { userId: true, ...MEMBERSHIP_SELECT },
    });
    if (!row) throw memberNotFound();
    return row;
  }

  async changeRole(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    role: 'ADMIN' | 'MODERATOR' | 'MEMBER',
  ): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    this.access.assertWritable(access);
    const target = await this.memberByOgcId(channelId, ogcId);
    if (target.status !== 'ACTIVE') throw memberNotFound();
    if (
      !access.role ||
      !canAssignRole(
        access.role,
        target.role,
        role,
        'COMMUNITY_CHANNEL',
        target.userId === auth.userId,
      )
    ) {
      throw channelForbidden('You cannot assign that role');
    }
    const changed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.channelMember.updateMany({
        where: { channelId, userId: target.userId, status: 'ACTIVE', role: target.role },
        data: { role },
      });
      if (count !== 1) return false;
      await tx.channelModerationAction.create({
        data: {
          channelId,
          moderatorId: auth.userId,
          action: 'ROLE_CHANGED',
          targetUserId: target.userId,
          reason: role,
        },
      });
      return true;
    });
    if (!changed) return;
    const version = await this.prisma.$transaction((tx) => nextChannelVersion(tx, channelId));
    this.realtime.toChannel(channelId, 'channel.updated', { channelId, version: Number(version) });
    await this.notifications.notify([
      {
        userId: target.userId,
        type: 'CHANNEL_ROLE_CHANGED',
        dedupeKey: `channel-role:${channelId}:${target.userId}:${String(Date.now())}`,
        data: { channelId, channelName: access.channel.name, role },
      },
    ]);
  }

  async transferOwnership(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    if (!access.role || !canTransferOwnership(access.role)) {
      throw channelForbidden('Only the owner can do that');
    }
    const target = await this.memberByOgcId(channelId, ogcId);
    if (target.status !== 'ACTIVE' || target.userId === auth.userId) throw memberNotFound();
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockChannel(tx, channelId))) throw channelNotFound();
      const demoted = await tx.channelMember.updateMany({
        where: { channelId, userId: auth.userId, role: 'OWNER' },
        data: { role: 'ADMIN' },
      });
      const promoted = await tx.channelMember.updateMany({
        where: { channelId, userId: target.userId, status: 'ACTIVE' },
        data: { role: 'OWNER', suspendedUntil: null },
      });
      if (demoted.count !== 1 || promoted.count !== 1) {
        throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'Membership changed; try again');
      }
      await tx.channelModerationAction.create({
        data: {
          channelId,
          moderatorId: auth.userId,
          action: 'OWNERSHIP_TRANSFERRED',
          targetUserId: target.userId,
        },
      });
      await this.audit.record(
        {
          type: 'CHANNEL_OWNERSHIP_TRANSFERRED',
          userId: auth.userId,
          sessionId: auth.sessionId,
          meta,
          details: { channelId },
        },
        tx,
      );
      await nextChannelVersion(tx, channelId);
    });
    const version = Number(
      (await this.access.requireReadable(auth.userId, channelId)).channel.version,
    );
    this.realtime.toChannel(channelId, 'channel.updated', { channelId, version });
    await this.notifications.notify([
      {
        userId: target.userId,
        type: 'CHANNEL_ROLE_CHANGED',
        dedupeKey: `channel-owner:${channelId}:${String(version)}`,
        data: { channelId, channelName: access.channel.name, role: 'OWNER' },
      },
    ]);
  }

  async setArchived(auth: AuthContext, channelId: string, archived: boolean): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    if (!access.role || !canArchiveOrDelete(access.role)) {
      throw channelForbidden('Only the owner can do that');
    }
    if ((access.channel.archivedAt !== null) === archived) return;
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await nextChannelVersion(tx, channelId);
      await tx.channel.update({
        where: { id: channelId },
        data: { archivedAt: archived ? new Date() : null },
      });
      await tx.channelModerationAction.create({
        data: { channelId, moderatorId: auth.userId, action: archived ? 'ARCHIVED' : 'UNARCHIVED' },
      });
      return v;
    });
    this.realtime.toChannel(channelId, 'channel.updated', { channelId, version: Number(version) });
  }

  /** Deletes the channel, its posts and media for everyone. Irreversible. */
  async delete(auth: AuthContext, channelId: string, meta: RequestMeta): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    if (!access.role || !canArchiveOrDelete(access.role)) {
      throw channelForbidden('Only the owner can do that');
    }
    const media = await this.prisma.channelAttachment.findMany({
      where: { channelId },
      select: { storageKey: true },
    });
    const members = await this.prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.channelAttachment.deleteMany({ where: { channelId } });
      await tx.channel.delete({ where: { id: channelId } });
      await this.audit.record(
        {
          type: 'CHANNEL_DELETED',
          userId: auth.userId,
          sessionId: auth.sessionId,
          meta,
          details: { channelId, members: members.length },
        },
        tx,
      );
    });
    const keys = [
      ...media.map((m) => m.storageKey),
      ...(access.channel.avatarKey ? [access.channel.avatarKey] : []),
    ];
    await Promise.all(keys.map((key) => this.removeObject(key)));
    this.realtime.toChannel(channelId, 'channel.access_revoked', { channelId });
    this.events.publish({
      type: 'membership.changed',
      channelId,
      userIds: members.map((m) => m.userId),
    });
  }

  async setPreferences(
    auth: AuthContext,
    channelId: string,
    input: { level?: 'ALL' | 'MENTIONS' | 'NONE' | undefined; mutedUntil?: string | null },
  ): Promise<NotificationPreferences> {
    await this.access.requireMember(auth.userId, channelId);
    const row = await this.prisma.channelMember.update({
      where: { channelId_userId: { channelId, userId: auth.userId } },
      data: {
        ...(input.level !== undefined ? { notificationLevel: input.level } : {}),
        ...(input.mutedUntil !== undefined
          ? { mutedUntil: input.mutedUntil === null ? null : new Date(input.mutedUntil) }
          : {}),
      },
      select: { notificationLevel: true, mutedUntil: true },
    });
    return { level: row.notificationLevel, mutedUntil: row.mutedUntil?.toISOString() ?? null };
  }

  /** Advances the caller's read mark (never backwards). */
  async markRead(auth: AuthContext, channelId: string, seq: number): Promise<void> {
    const access = await this.access.requireMember(auth.userId, channelId);
    const capped = BigInt(Math.min(seq, Number(access.channel.version)));
    const { count } = await this.prisma.channelMember.updateMany({
      where: { channelId, userId: auth.userId, lastReadSeq: { lt: capped } },
      data: { lastReadSeq: capped },
    });
    if (count === 1) {
      this.realtime.toUsers([auth.userId], 'channel.updated', {
        channelId,
        version: Number(access.channel.version),
      });
    }
  }

  private async ogcIdOf(userId: string): Promise<OgcId> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ogcId: true },
    });
    return user.ogcId as OgcId;
  }
}
