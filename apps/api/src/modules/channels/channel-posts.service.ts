import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  ChannelPostPage,
  ChannelPostView,
  ChannelSyncPage,
  OgcId,
  ReactionType,
} from '@ogc/types';
import { PINNED_POSTS_MAX } from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import { blankToNull } from '../../common/text.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext } from '../auth/auth-context.js';
import { canEditDetails, canModerate } from '../community/community-permissions.js';
import { MESSAGE_EDIT_WINDOW_MS } from '../conversations/messaging.constants.js';
import { CommunityNotificationsService } from '../notifications/community-notifications.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import {
  type ChannelAccess,
  ChannelAccessService,
  channelForbidden,
  postNotFound,
} from './channel-access.service.js';
import { nextChannelVersion } from './channel-version.js';
import { POST_SELECT, type PostRow, reactionSummaries, toPostView } from './channel-views.js';

export interface ChannelPostInput {
  clientPostId: string;
  body?: string | undefined;
  replyToId?: string | undefined;
  announcement?: boolean | undefined;
  attachmentIds?: string[] | undefined;
  mentions?: OgcId[] | undefined;
}

const invalid = (message: string): ApiException =>
  new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message);

/** Announcement fan-out is bounded; larger channels rely on realtime and the unread badge. */
const ANNOUNCEMENT_NOTIFY_MAX = 10_000;

/**
 * Posts in community channels (server-readable). Top-level posts follow the
 * channel's post policy; replies (discussion) are open to active members when
 * enabled; announcements are for owners and administrators. Every change takes
 * the channel's next version, so `sync` returns changes in commit order.
 */
@Injectable()
export class ChannelPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly relationships: RelationshipService,
    private readonly notifications: CommunityNotificationsService,
    private readonly realtime: RealtimePublisher,
    private readonly storage: ObjectStorage,
    private readonly metrics: MetricsService,
  ) {}

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  async render(
    viewerId: string,
    access: ChannelAccess,
    rows: PostRow[],
  ): Promise<ChannelPostView[]> {
    const authors = rows.flatMap((r) => (r.author ? [r.author] : []));
    const [summaries, reactions] = await Promise.all([
      this.relationships.summariesFor(viewerId, [
        ...new Map(authors.map((a) => [a.id, a])).values(),
      ]),
      reactionSummaries(
        this.prisma,
        rows.map((r) => r.id),
        viewerId,
      ),
    ]);
    const moderator = access.role !== null && canModerate(access.role);
    return rows.map((row) => toPostView(row, { moderator, authors: summaries, reactions }));
  }

  async renderOne(viewerId: string, access: ChannelAccess, row: PostRow): Promise<ChannelPostView> {
    const [view] = await this.render(viewerId, access, [row]);
    if (!view) throw new Error('Post view missing');
    return view;
  }

  private async loadPost(
    viewerId: string,
    postId: string,
  ): Promise<{ row: PostRow; access: ChannelAccess }> {
    const row = await this.prisma.channelPost.findUnique({
      where: { id: postId },
      select: POST_SELECT,
    });
    if (!row) throw postNotFound();
    const access = await this.access.load(viewerId, row.channelId);
    if (!access || !this.access.canRead(access)) throw postNotFound();
    return { row, access };
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** Idempotent on (author, clientPostId). */
  async create(
    auth: AuthContext,
    channelId: string,
    input: ChannelPostInput,
  ): Promise<ChannelPostView> {
    const access = await this.access.requireMember(auth.userId, channelId);
    const existing = await this.prisma.channelPost.findUnique({
      where: { authorId_clientPostId: { authorId: auth.userId, clientPostId: input.clientPostId } },
      select: POST_SELECT,
    });
    if (existing) {
      if (existing.channelId !== channelId) {
        throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'Post ID already used');
      }
      return await this.renderOne(auth.userId, access, existing);
    }
    this.access.assertCanParticipate(access);
    const role = access.role ?? 'MEMBER';
    if (input.replyToId) {
      if (!access.channel.repliesEnabled) throw channelForbidden('Replies are turned off here');
    } else if (!this.access.canPostTopLevel(access)) {
      throw channelForbidden(
        access.channel.postPolicy === 'MODERATORS'
          ? 'Only moderators and administrators can post here'
          : 'Only administrators can post here',
      );
    }
    if (input.announcement && !canEditDetails(role)) {
      throw channelForbidden('Only administrators can post announcements');
    }

    let row: PostRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const version = await nextChannelVersion(tx, channelId, { post: true });
        if (input.replyToId) {
          const parent = await tx.channelPost.findFirst({
            where: { id: input.replyToId, channelId, deletedAt: null, removedAt: null },
            select: { replyToId: true },
          });
          if (!parent) throw invalid('replyToId: Post not found in this channel');
          if (parent.replyToId) throw invalid('replyToId: Reply to the original post');
        }
        const created = await tx.channelPost.create({
          data: {
            channelId,
            seq: version,
            version,
            authorId: auth.userId,
            clientPostId: input.clientPostId,
            body: blankToNull(input.body),
            replyToId: input.replyToId ?? null,
            announcement: input.announcement === true,
          },
          select: { id: true },
        });
        await this.attach(tx, auth.userId, channelId, created.id, input.attachmentIds);
        // The author has read their own post.
        await tx.channelMember.updateMany({
          where: { channelId, userId: auth.userId, lastReadSeq: { lt: version } },
          data: { lastReadSeq: version },
        });
        return tx.channelPost.findUniqueOrThrow({ where: { id: created.id }, select: POST_SELECT });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'client_post_id')) {
        const replay = await this.prisma.channelPost.findUnique({
          where: {
            authorId_clientPostId: { authorId: auth.userId, clientPostId: input.clientPostId },
          },
          select: POST_SELECT,
        });
        if (replay?.channelId === channelId) {
          return await this.renderOne(auth.userId, access, replay);
        }
      }
      throw error;
    }
    this.metrics.channelPosts.inc({
      kind: row.announcement ? 'announcement' : row.replyToId ? 'reply' : 'post',
    });
    const payload = { channelId, postId: row.id, version: Number(row.version) };
    this.realtime.toChannel(channelId, 'channel.post_created', payload);
    if (row.announcement) {
      this.realtime.toChannel(channelId, 'channel.announcement_created', payload);
      await this.notifyAnnouncement(access, row, auth.userId);
    }
    await this.notifyMentions(access, row, auth.userId, input.mentions ?? []);
    return await this.renderOne(auth.userId, access, row);
  }

  private async attach(
    tx: Prisma.TransactionClient,
    uploaderId: string,
    channelId: string,
    postId: string,
    attachmentIds: string[] | undefined,
  ): Promise<void> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return;
    const { count } = await tx.channelAttachment.updateMany({
      where: { id: { in: ids }, uploaderId, channelId, postId: null },
      data: { postId },
    });
    if (count !== ids.length) throw invalid('attachmentIds: Unknown or already used attachment');
  }

  private async notifyAnnouncement(
    access: ChannelAccess,
    row: PostRow,
    authorId: string,
  ): Promise<void> {
    const recipients = await this.prisma.channelMember.findMany({
      where: {
        channelId: access.channel.id,
        status: 'ACTIVE',
        userId: { not: authorId },
        notificationLevel: { not: 'NONE' },
        OR: [{ mutedUntil: null }, { mutedUntil: { lt: new Date() } }],
      },
      take: ANNOUNCEMENT_NOTIFY_MAX,
      select: { userId: true },
    });
    await this.notifications.notify(
      recipients.map((r) => ({
        userId: r.userId,
        type: 'CHANNEL_ANNOUNCEMENT' as const,
        dedupeKey: `announcement:${row.id}`,
        data: { channelId: access.channel.id, channelName: access.channel.name, postId: row.id },
      })),
    );
  }

  private async notifyMentions(
    access: ChannelAccess,
    row: PostRow,
    authorId: string,
    mentions: OgcId[],
  ): Promise<void> {
    if (mentions.length === 0) return;
    const recipients = await this.prisma.channelMember.findMany({
      where: {
        channelId: access.channel.id,
        status: 'ACTIVE',
        notificationLevel: { not: 'NONE' },
        userId: { not: authorId },
        user: {
          ogcId: { in: mentions },
          blocksMade: { none: { blockedId: authorId } },
        },
      },
      select: { userId: true },
    });
    await this.notifications.notify(
      recipients.map((r) => ({
        userId: r.userId,
        type: 'MENTION' as const,
        dedupeKey: `mention:${row.id}`,
        data: { channelId: access.channel.id, channelName: access.channel.name, postId: row.id },
      })),
    );
  }

  /** Authors edit their own posts within 48 hours. */
  async edit(auth: AuthContext, postId: string, body: string): Promise<ChannelPostView> {
    const { row, access } = await this.loadPost(auth.userId, postId);
    if (row.authorId !== auth.userId) throw channelForbidden('You can only edit your own posts');
    this.access.assertCanParticipate(access);
    if (row.deletedAt || row.removedAt) {
      throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This post was deleted');
    }
    if (Date.now() - row.createdAt.getTime() > MESSAGE_EDIT_WINDOW_MS) {
      throw channelForbidden('This post can no longer be edited');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const version = await nextChannelVersion(tx, row.channelId);
      const { count } = await tx.channelPost.updateMany({
        where: { id: postId, deletedAt: null, removedAt: null },
        data: { body, editedAt: new Date(), version },
      });
      if (count !== 1)
        throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This post was deleted');
      return tx.channelPost.findUniqueOrThrow({ where: { id: postId }, select: POST_SELECT });
    });
    this.realtime.toChannel(row.channelId, 'channel.post_updated', {
      channelId: row.channelId,
      postId,
      version: Number(updated.version),
    });
    return await this.renderOne(auth.userId, access, updated);
  }

  /**
   * Authors delete their own posts at any time: text, reactions and media are
   * removed from the server; a "deleted" placeholder remains for threads.
   */
  async delete(auth: AuthContext, postId: string): Promise<void> {
    const { row, access } = await this.loadPost(auth.userId, postId);
    if (row.authorId !== auth.userId) {
      throw channelForbidden('You can only delete your own posts; moderators remove posts');
    }
    if (row.deletedAt) return;
    if (!access.active) throw channelForbidden('Join this channel first');
    const { version, keys } = await this.prisma.$transaction(async (tx) => {
      const v = await nextChannelVersion(tx, row.channelId);
      await tx.channelPost.update({
        where: { id: postId },
        data: { body: null, deletedAt: new Date(), pinnedAt: null, version: v },
      });
      await tx.channelPostReaction.deleteMany({ where: { postId } });
      const media = await tx.channelAttachment.findMany({
        where: { postId },
        select: { storageKey: true },
      });
      await tx.channelAttachment.deleteMany({ where: { postId } });
      return { version: v, keys: media.map((m) => m.storageKey) };
    });
    await Promise.all(keys.map((key) => this.storage.delete(key)));
    this.realtime.toChannel(row.channelId, 'channel.post_deleted', {
      channelId: row.channelId,
      postId,
      version: Number(version),
    });
  }

  async react(
    auth: AuthContext,
    postId: string,
    reaction: ReactionType,
    add: boolean,
  ): Promise<void> {
    const { row, access } = await this.loadPost(auth.userId, postId);
    if (add) this.access.assertCanParticipate(access);
    else if (!access.active) throw channelForbidden('Join this channel first');
    if (row.deletedAt || row.removedAt) {
      throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This post was deleted');
    }
    const version = await this.prisma.$transaction(async (tx) => {
      const key = { postId_userId_reaction: { postId, userId: auth.userId, reaction } };
      const exists = await tx.channelPostReaction.findUnique({ where: key });
      if (add === (exists !== null)) return undefined;
      const v = await nextChannelVersion(tx, row.channelId);
      if (add)
        await tx.channelPostReaction.create({ data: { postId, userId: auth.userId, reaction } });
      else await tx.channelPostReaction.delete({ where: key });
      await tx.channelPost.update({ where: { id: postId }, data: { version: v } });
      return v;
    });
    if (version === undefined) return;
    this.realtime.toChannel(row.channelId, 'channel.post_updated', {
      channelId: row.channelId,
      postId,
      version: Number(version),
    });
  }

  /** Moderators pin up to 10 posts. */
  async setPinned(auth: AuthContext, postId: string, pinned: boolean): Promise<void> {
    const { row, access } = await this.loadPost(auth.userId, postId);
    if (!access.active || !access.role || !canModerate(access.role)) throw channelForbidden();
    this.access.assertWritable(access);
    if (pinned && (row.deletedAt || row.removedAt || row.replyToId)) {
      throw channelForbidden('Only visible top-level posts can be pinned');
    }
    if ((row.pinnedAt !== null) === pinned) return;
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await nextChannelVersion(tx, row.channelId);
      if (pinned) {
        const count = await tx.channelPost.count({
          where: { channelId: row.channelId, pinnedAt: { not: null } },
        });
        if (count >= PINNED_POSTS_MAX) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            'CONFLICT',
            `At most ${String(PINNED_POSTS_MAX)} posts can be pinned`,
          );
        }
      }
      await tx.channelPost.update({
        where: { id: postId },
        data: { pinnedAt: pinned ? new Date() : null, version: v },
      });
      await tx.channelModerationAction.create({
        data: {
          channelId: row.channelId,
          moderatorId: auth.userId,
          action: pinned ? 'PIN_POST' : 'UNPIN_POST',
          targetPostId: postId,
          targetUserId: row.authorId,
        },
      });
      return v;
    });
    this.realtime.toChannel(row.channelId, 'channel.post_pinned', {
      channelId: row.channelId,
      postId,
      version: Number(version),
      pinned,
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Top-level posts, newest first (`before` pages backwards); optional text search. */
  async feed(
    viewerId: string,
    channelId: string,
    query: { before?: number | undefined; q?: string | undefined; limit: number },
  ): Promise<ChannelPostPage> {
    const access = await this.access.requireReadable(viewerId, channelId);
    const rows = await this.prisma.channelPost.findMany({
      where: {
        channelId,
        replyToId: null,
        ...(query.before !== undefined ? { seq: { lt: BigInt(query.before) } } : {}),
        ...(query.q
          ? { body: { contains: query.q, mode: 'insensitive' }, deletedAt: null, removedAt: null }
          : {}),
      },
      orderBy: { seq: 'desc' },
      take: query.limit + 1,
      select: POST_SELECT,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await this.render(viewerId, access, page),
      nextCursor: rows.length > query.limit && last ? String(last.seq) : null,
    };
  }

  /** A post with its replies, oldest reply first. */
  async thread(
    viewerId: string,
    postId: string,
    query: { after?: number | undefined; limit: number },
  ): Promise<{ post: ChannelPostView; replies: ChannelPostPage }> {
    const { row, access } = await this.loadPost(viewerId, postId);
    const replies = await this.prisma.channelPost.findMany({
      where: {
        channelId: row.channelId,
        replyToId: postId,
        ...(query.after !== undefined ? { seq: { gt: BigInt(query.after) } } : {}),
      },
      orderBy: { seq: 'asc' },
      take: query.limit + 1,
      select: POST_SELECT,
    });
    const page = replies.slice(0, query.limit);
    const last = page.at(-1);
    const [post, ...items] = await this.render(viewerId, access, [row, ...page]);
    if (!post) throw new Error('Post view missing');
    return {
      post,
      replies: {
        items,
        nextCursor: replies.length > query.limit && last ? String(last.seq) : null,
      },
    };
  }

  async pinned(viewerId: string, channelId: string): Promise<ChannelPostView[]> {
    const access = await this.access.requireReadable(viewerId, channelId);
    const rows = await this.prisma.channelPost.findMany({
      where: { channelId, pinnedAt: { not: null }, deletedAt: null, removedAt: null },
      orderBy: { pinnedAt: 'desc' },
      take: PINNED_POSTS_MAX,
      select: POST_SELECT,
    });
    return this.render(viewerId, access, rows);
  }

  /** Posts changed after `after` (version order) — reconnect and multi-device sync. */
  async sync(
    viewerId: string,
    channelId: string,
    after: number,
    limit: number,
  ): Promise<ChannelSyncPage> {
    const access = await this.access.requireReadable(viewerId, channelId);
    const upTo = access.channel.version;
    if (BigInt(after) >= upTo) return { items: [], version: Number(upTo), hasMore: false };
    const rows = await this.prisma.channelPost.findMany({
      where: { channelId, version: { gt: BigInt(after), lte: upTo } },
      orderBy: { version: 'asc' },
      take: limit + 1,
      select: POST_SELECT,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await this.render(viewerId, access, page),
      version: hasMore && last ? Number(last.version) : Number(upTo),
      hasMore,
    };
  }
}
