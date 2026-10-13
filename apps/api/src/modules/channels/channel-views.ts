import type {
  ChannelPostView,
  ChannelReactionSummary,
  ChannelView,
  ProfileSummary,
  ReactionType,
} from '@ogc/types';
import { REACTION_TYPES } from '@ogc/types';
import type { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { canModerate, canPost } from '../community/community-permissions.js';
import { avatarVersion } from '../conversations/conversations.service.js';
import { type ChannelRow, type MembershipRow, isSuspended } from './channel-access.service.js';

export function channelAvatarUrl(channelId: string, avatarKey: string | null): string | null {
  if (!avatarKey) return null;
  return `/api/v1/channels/${channelId}/avatar?v=${avatarVersion(avatarKey)}`;
}

export function toChannelView(
  channel: ChannelRow,
  membership: MembershipRow | null,
  unreadCount: number,
): ChannelView {
  const active = membership?.status === 'ACTIVE';
  const writable = active && channel.archivedAt === null && !isSuspended(membership);
  return {
    id: channel.id,
    handle: channel.handle,
    name: channel.name,
    description: channel.description,
    avatarUrl: channelAvatarUrl(channel.id, channel.avatarKey),
    visibility: channel.visibility,
    joinPolicy: channel.joinPolicy,
    postPolicy: channel.postPolicy,
    repliesEnabled: channel.repliesEnabled,
    memberCount: channel.memberCount,
    version: Number(channel.version),
    archived: channel.archivedAt !== null,
    lastPostAt: channel.lastPostAt?.toISOString() ?? null,
    createdAt: channel.createdAt.toISOString(),
    endToEndEncrypted: false,
    membership: membership
      ? {
          role: membership.role,
          status: membership.status,
          suspendedUntil: membership.suspendedUntil?.toISOString() ?? null,
          notificationLevel: membership.notificationLevel,
          mutedUntil: membership.mutedUntil?.toISOString() ?? null,
          lastReadSeq: Number(membership.lastReadSeq),
        }
      : null,
    unreadCount: active ? unreadCount : 0,
    canPost: writable && canPost(membership.role, channel.postPolicy),
    canReply: writable && channel.repliesEnabled,
    canModerate: active && canModerate(membership.role),
  };
}

export const POST_SELECT = {
  id: true,
  channelId: true,
  seq: true,
  version: true,
  authorId: true,
  clientPostId: true,
  body: true,
  replyToId: true,
  announcement: true,
  pinnedAt: true,
  editedAt: true,
  deletedAt: true,
  removedAt: true,
  createdAt: true,
  author: {
    select: {
      id: true,
      ogcId: true,
      profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
    },
  },
  attachments: {
    select: { id: true, kind: true, name: true, mime: true, size: true },
    orderBy: { createdAt: 'asc' },
  },
  _count: { select: { replies: { where: { deletedAt: null, removedAt: null } } } },
} as const satisfies Prisma.ChannelPostSelect;

export type PostRow = Prisma.ChannelPostGetPayload<{ select: typeof POST_SELECT }>;

export interface PostRenderContext {
  /** Moderators see removed posts' text (for review and restore). */
  moderator: boolean;
  authors: Map<string, ProfileSummary>;
  reactions: Map<string, ChannelReactionSummary[]>;
}

export function toPostView(row: PostRow, context: PostRenderContext): ChannelPostView {
  const removed = row.removedAt !== null;
  const hidden = row.deletedAt !== null || removed;
  return {
    id: row.id,
    channelId: row.channelId,
    seq: Number(row.seq),
    version: Number(row.version),
    author: row.authorId ? (context.authors.get(row.authorId) ?? null) : null,
    clientPostId: row.clientPostId,
    body: hidden ? null : row.body,
    replyToId: row.replyToId,
    replyCount: row._count.replies,
    announcement: row.announcement,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    removed,
    ...(removed && context.moderator && row.deletedAt === null ? { removedBody: row.body } : {}),
    createdAt: row.createdAt.toISOString(),
    reactions: hidden ? [] : (context.reactions.get(row.id) ?? []),
    attachments: hidden
      ? []
      : row.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          mime: a.mime,
          size: a.size,
          url: `/api/v1/channel-attachments/${a.id}`,
        })),
  };
}

const REACTION_ORDER = new Map<string, number>(REACTION_TYPES.map((r, i) => [r, i]));

/** Reaction counts per post plus which ones are the viewer's, in two grouped queries. */
export async function reactionSummaries(
  prisma: PrismaService,
  postIds: string[],
  viewerId: string,
): Promise<Map<string, ChannelReactionSummary[]>> {
  if (postIds.length === 0) return new Map();
  const [counts, mine] = await Promise.all([
    prisma.channelPostReaction.groupBy({
      by: ['postId', 'reaction'],
      where: { postId: { in: postIds } },
      _count: { _all: true },
    }),
    prisma.channelPostReaction.findMany({
      where: { postId: { in: postIds }, userId: viewerId },
      select: { postId: true, reaction: true },
    }),
  ]);
  const own = new Set(mine.map((m) => `${m.postId}:${m.reaction}`));
  const result = new Map<string, ChannelReactionSummary[]>();
  for (const c of counts) {
    const list = result.get(c.postId) ?? [];
    list.push({
      reaction: c.reaction as ReactionType,
      count: c._count._all,
      mine: own.has(`${c.postId}:${c.reaction}`),
    });
    result.set(c.postId, list);
  }
  for (const list of result.values()) {
    list.sort(
      (a, b) => (REACTION_ORDER.get(a.reaction) ?? 0) - (REACTION_ORDER.get(b.reaction) ?? 0),
    );
  }
  return result;
}
