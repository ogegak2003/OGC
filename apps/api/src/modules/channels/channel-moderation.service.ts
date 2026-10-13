import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  ChannelPostReportView,
  ModerationActionView,
  OgcId,
  Page,
  ReportCategory,
} from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { blankToNull } from '../../common/text.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { CommunityRole, ModerationActionType, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { canActOnMember, outranks } from '../community/community-permissions.js';
import { CommunityNotificationsService } from '../notifications/community-notifications.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import {
  type ChannelAccess,
  ChannelAccessService,
  channelForbidden,
  postNotFound,
} from './channel-access.service.js';
import { ChannelPostsService } from './channel-posts.service.js';
import { lockChannel, nextChannelVersion } from './channel-version.js';
import { POST_SELECT } from './channel-views.js';
import { ChannelsService } from './channels.service.js';

const HOUR = 60 * 60_000;

const memberNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Member not found');

const reportNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Report not found');

/**
 * Channel moderation (ADR-035). Moderators act on posts and on members with a
 * lower role (moderators: members only); owners and administrators on lower
 * roles. Every action is recorded with its reason in the channel's moderation
 * history and the audit log. Moderation works on server-readable community
 * channels only — nothing here can read end-to-end encrypted content.
 */
@Injectable()
export class ChannelModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly channels: ChannelsService,
    private readonly posts: ChannelPostsService,
    private readonly relationships: RelationshipService,
    private readonly notifications: CommunityNotificationsService,
    private readonly realtime: RealtimePublisher,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  private async log(
    tx: Prisma.TransactionClient,
    access: ChannelAccess,
    action: ModerationActionType,
    data: {
      targetUserId?: string | null;
      targetPostId?: string | null;
      reason?: string | undefined;
      until?: Date | null;
    },
    meta?: RequestMeta,
    auth?: AuthContext,
  ): Promise<void> {
    await tx.channelModerationAction.create({
      data: {
        channelId: access.channel.id,
        moderatorId: access.viewerId,
        action,
        targetUserId: data.targetUserId ?? null,
        targetPostId: data.targetPostId ?? null,
        reason: blankToNull(data.reason),
        until: data.until ?? null,
      },
    });
    await this.audit.record(
      {
        type: 'CHANNEL_MODERATION',
        userId: access.viewerId,
        sessionId: auth?.sessionId,
        meta,
        details: { channelId: access.channel.id, action },
      },
      tx,
    );
    this.metrics.communityEvents.inc({ event: `moderation_${action.toLowerCase()}` });
  }

  // -------------------------------------------------------------------------
  // Posts
  // -------------------------------------------------------------------------

  /** Hides a post from members (moderators can still review and restore it). */
  async setRemoved(
    auth: AuthContext,
    postId: string,
    removed: boolean,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const post = await this.prisma.channelPost.findUnique({
      where: { id: postId },
      select: { id: true, channelId: true, authorId: true, removedAt: true, deletedAt: true },
    });
    if (!post) throw postNotFound();
    // Readers who are not moderators learn only that they may not do this.
    await this.access.requireReadable(auth.userId, post.channelId).catch(() => {
      throw postNotFound();
    });
    const access = await this.access.requireModerator(auth.userId, post.channelId);
    if (post.deletedAt)
      throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This post was deleted');
    if (post.authorId && post.authorId !== auth.userId) {
      const author = await this.prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId: post.channelId, userId: post.authorId } },
        select: { role: true, status: true },
      });
      const authorRole: CommunityRole = author?.status === 'ACTIVE' ? author.role : 'MEMBER';
      if (!access.role || !outranks(access.role, authorRole)) {
        throw channelForbidden(
          'You cannot moderate posts of members with the same or a higher role',
        );
      }
    }
    if ((post.removedAt !== null) === removed) return;
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await nextChannelVersion(tx, post.channelId);
      await tx.channelPost.update({
        where: { id: postId },
        data: {
          removedAt: removed ? new Date() : null,
          version: v,
          ...(removed ? { pinnedAt: null } : {}),
        },
      });
      await this.log(
        tx,
        access,
        removed ? 'REMOVE_POST' : 'RESTORE_POST',
        { targetPostId: postId, targetUserId: post.authorId, reason },
        meta,
        auth,
      );
      return v;
    });
    this.realtime.toChannel(post.channelId, 'channel.post_updated', {
      channelId: post.channelId,
      postId,
      version: Number(version),
    });
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  private async targetFor(
    access: ChannelAccess,
    ogcId: OgcId,
  ): Promise<{ userId: string; role: CommunityRole; status: 'ACTIVE' | 'PENDING' | 'BANNED' }> {
    const target = await this.prisma.channelMember.findFirst({
      where: { channelId: access.channel.id, user: { ogcId } },
      select: { userId: true, role: true, status: true },
    });
    if (!target) throw memberNotFound();
    if (target.userId === access.viewerId) throw channelForbidden('You cannot moderate yourself');
    if (!access.role || !canActOnMember(access.role, target.role, 'COMMUNITY_CHANNEL')) {
      throw channelForbidden('You cannot moderate this member');
    }
    return target;
  }

  /** Suspends posting, replying and reacting for a number of hours (0 lifts it). */
  async suspend(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    hours: number,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireModerator(auth.userId, channelId);
    const target = await this.targetFor(access, ogcId);
    if (target.status !== 'ACTIVE') throw memberNotFound();
    const until = hours > 0 ? new Date(Date.now() + hours * HOUR) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.channelMember.update({
        where: { channelId_userId: { channelId, userId: target.userId } },
        data: { suspendedUntil: until },
      });
      await this.log(
        tx,
        access,
        until ? 'SUSPEND' : 'UNSUSPEND',
        { targetUserId: target.userId, reason, until },
        meta,
        auth,
      );
    });
    await this.tellTarget(
      target.userId,
      channelId,
      access.channel.name,
      until ? 'suspended' : 'unsuspended',
    );
  }

  /** Removes a member; they can rejoin public channels (use a ban to prevent that). */
  async removeMember(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireModerator(auth.userId, channelId);
    const target = await this.targetFor(access, ogcId);
    if (target.status === 'BANNED') throw memberNotFound();
    await this.prisma.$transaction(async (tx) => {
      const status = await this.channels.removeMembership(channelId, target.userId, tx);
      if (!status) throw memberNotFound();
      await this.log(
        tx,
        access,
        status === 'PENDING' ? 'REJECT_MEMBER' : 'REMOVE_MEMBER',
        { targetUserId: target.userId, reason },
        meta,
        auth,
      );
    });
    this.realtime.setChannelMembership(target.userId, channelId, false);
    this.realtime.toUsers([target.userId], 'channel.access_revoked', { channelId });
    await this.tellTarget(target.userId, channelId, access.channel.name, 'removed');
  }

  /**
   * Bans an account (member or not): they lose access immediately, cannot
   * rejoin — also not through invitation links — and cannot read the channel
   * if it is private.
   */
  async ban(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireModerator(auth.userId, channelId);
    const user = await this.prisma.user.findUnique({ where: { ogcId }, select: { id: true } });
    if (!user) throw memberNotFound();
    if (user.id === auth.userId) throw channelForbidden('You cannot moderate yourself');
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockChannel(tx, channelId))) throw memberNotFound();
      const existing = await tx.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: user.id } },
        select: { role: true, status: true },
      });
      if (existing?.status === 'BANNED') return;
      const role: CommunityRole = existing?.role ?? 'MEMBER';
      if (!access.role || !canActOnMember(access.role, role, 'COMMUNITY_CHANNEL')) {
        throw channelForbidden('You cannot moderate this member');
      }
      await tx.channelMember.upsert({
        where: { channelId_userId: { channelId, userId: user.id } },
        create: { channelId, userId: user.id, role: 'MEMBER', status: 'BANNED' },
        update: { role: 'MEMBER', status: 'BANNED', suspendedUntil: null },
      });
      if (existing?.status === 'ACTIVE') {
        await tx.channel.update({
          where: { id: channelId },
          data: { memberCount: { decrement: 1 } },
        });
      }
      await this.log(tx, access, 'BAN', { targetUserId: user.id, reason }, meta, auth);
    });
    this.realtime.setChannelMembership(user.id, channelId, false);
    this.realtime.toUsers([user.id], 'channel.access_revoked', { channelId });
  }

  async unban(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireModerator(auth.userId, channelId);
    const target = await this.prisma.channelMember.findFirst({
      where: { channelId, status: 'BANNED', user: { ogcId } },
      select: { userId: true },
    });
    if (!target) throw memberNotFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.channelMember.delete({
        where: { channelId_userId: { channelId, userId: target.userId } },
      });
      await this.log(tx, access, 'UNBAN', { targetUserId: target.userId, reason }, meta, auth);
    });
  }

  /** Approves or rejects a pending join request. */
  async decideRequest(
    auth: AuthContext,
    channelId: string,
    ogcId: OgcId,
    approve: boolean,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireModerator(auth.userId, channelId);
    this.access.assertWritable(access);
    const target = await this.prisma.channelMember.findFirst({
      where: { channelId, status: 'PENDING', user: { ogcId } },
      select: { userId: true },
    });
    if (!target) throw memberNotFound();
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockChannel(tx, channelId))) throw memberNotFound();
      if (approve) {
        const { count } = await tx.channelMember.updateMany({
          where: { channelId, userId: target.userId, status: 'PENDING' },
          data: { status: 'ACTIVE', joinedAt: new Date() },
        });
        if (count !== 1) throw memberNotFound();
        await tx.channel.update({
          where: { id: channelId },
          data: { memberCount: { increment: 1 } },
        });
      } else {
        const { count } = await tx.channelMember.deleteMany({
          where: { channelId, userId: target.userId, status: 'PENDING' },
        });
        if (count !== 1) throw memberNotFound();
      }
      await this.log(
        tx,
        access,
        approve ? 'APPROVE_MEMBER' : 'REJECT_MEMBER',
        { targetUserId: target.userId },
        meta,
        auth,
      );
    });
    if (approve) {
      this.realtime.setChannelMembership(target.userId, channelId, true);
      this.realtime.toUsers([target.userId], 'channel.member_joined', { channelId, ogcId });
      await this.notifications.notify([
        {
          userId: target.userId,
          type: 'CHANNEL_REQUEST_APPROVED',
          dedupeKey: `channel-approved:${channelId}:${target.userId}:${String(Date.now())}`,
          data: { channelId, channelName: access.channel.name },
        },
      ]);
    }
  }

  private async tellTarget(
    userId: string,
    channelId: string,
    channelName: string,
    outcome: 'suspended' | 'unsuspended' | 'removed',
  ): Promise<void> {
    await this.notifications.notify([
      {
        userId,
        type: 'CHANNEL_MEMBER_REMOVED',
        dedupeKey: `channel-moderation:${channelId}:${userId}:${outcome}:${String(Date.now())}`,
        data: { channelId, channelName, outcome },
      },
    ]);
  }

  // -------------------------------------------------------------------------
  // Reports and history
  // -------------------------------------------------------------------------

  /** Anyone who can read a post can report it to the channel's moderators. */
  async report(
    auth: AuthContext,
    postId: string,
    input: { category: ReportCategory; description?: string | undefined },
  ): Promise<void> {
    const post = await this.prisma.channelPost.findUnique({
      where: { id: postId },
      select: { channelId: true, authorId: true, deletedAt: true },
    });
    if (!post || post.deletedAt) throw postNotFound();
    await this.access.requireReadable(auth.userId, post.channelId).catch(() => {
      throw postNotFound();
    });
    if (post.authorId === auth.userId) throw channelForbidden('You cannot report your own post');
    await this.prisma.channelPostReport.create({
      data: {
        channelId: post.channelId,
        postId,
        reporterId: auth.userId,
        category: input.category,
        description: blankToNull(input.description),
      },
    });
    this.metrics.communityEvents.inc({ event: 'channel_post_reported' });
  }

  async reports(
    auth: AuthContext,
    channelId: string,
    status: 'OPEN' | 'RESOLVED' | 'DISMISSED',
    page: { cursor?: string | undefined; limit: number },
  ): Promise<Page<ChannelPostReportView>> {
    const access = await this.access.requireModerator(auth.userId, channelId);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.channelPostReport.findMany({
      where: { channelId, status, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        reporterId: true,
        category: true,
        description: true,
        status: true,
        resolution: true,
        createdAt: true,
        post: { select: POST_SELECT },
      },
    });
    const rendered = await this.posts.render(
      auth.userId,
      access,
      rows.map((r) => r.post),
    );
    const reporters = await this.prisma.user.findMany({
      where: { id: { in: rows.flatMap((r) => (r.reporterId ? [r.reporterId] : [])) } },
      select: {
        id: true,
        ogcId: true,
        profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
      },
    });
    const summaries = await this.relationships.summariesFor(auth.userId, reporters);
    const byPost = new Map(rendered.map((p) => [p.id, p]));
    const visible = rows.flatMap((r) => {
      const post = byPost.get(r.post.id);
      return post ? [{ ...r, view: post }] : [];
    });
    return toPage(visible, page.limit, (r) => ({
      id: r.id,
      post: r.view,
      reporter: r.reporterId ? (summaries.get(r.reporterId) ?? null) : null,
      category: r.category,
      description: r.description,
      status: r.status,
      resolution: r.resolution,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Resolves or dismisses a report, optionally removing the post; the reporter is told. */
  async resolveReport(
    auth: AuthContext,
    reportId: string,
    input: {
      outcome: 'RESOLVED' | 'DISMISSED';
      resolution?: string | undefined;
      removePost?: boolean | undefined;
    },
    meta: RequestMeta,
  ): Promise<void> {
    const report = await this.prisma.channelPostReport.findUnique({
      where: { id: reportId },
      select: { id: true, channelId: true, postId: true, reporterId: true, status: true },
    });
    if (!report) throw reportNotFound();
    const access = await this.access.requireModerator(auth.userId, report.channelId).catch(() => {
      throw reportNotFound();
    });
    if (report.status !== 'OPEN') return;
    if (input.outcome === 'RESOLVED' && input.removePost) {
      await this.setRemoved(auth, report.postId, true, input.resolution, meta);
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.channelPostReport.updateMany({
        where: { id: reportId, status: 'OPEN' },
        data: {
          status: input.outcome,
          resolution: blankToNull(input.resolution),
          resolvedAt: new Date(),
        },
      });
      if (count !== 1) return;
      await this.log(
        tx,
        access,
        input.outcome === 'RESOLVED' ? 'RESOLVE_REPORT' : 'DISMISS_REPORT',
        { targetPostId: report.postId, reason: input.resolution },
        meta,
        auth,
      );
    });
    if (report.reporterId) {
      await this.notifications.notify([
        {
          userId: report.reporterId,
          type: 'MODERATION_RESULT',
          dedupeKey: `report-result:${report.id}`,
          data: {
            channelId: report.channelId,
            channelName: access.channel.name,
            outcome: input.outcome,
          },
        },
      ]);
    }
  }

  /** Moderation history, newest first (moderators only). */
  async history(
    auth: AuthContext,
    channelId: string,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<Page<ModerationActionView>> {
    await this.access.requireModerator(auth.userId, channelId);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.channelModerationAction.findMany({
      where: { channelId, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.moderatorId, r.targetUserId]).filter((id) => id !== null)),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        ogcId: true,
        profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
      },
    });
    const summaries = await this.relationships.summariesFor(auth.userId, users);
    return toPage(rows, page.limit, (r) => ({
      id: r.id,
      action: r.action,
      moderator: r.moderatorId ? (summaries.get(r.moderatorId) ?? null) : null,
      target: r.targetUserId ? (summaries.get(r.targetUserId) ?? null) : null,
      postId: r.targetPostId,
      reason: r.reason,
      until: r.until?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
