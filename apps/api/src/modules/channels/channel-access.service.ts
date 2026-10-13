import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  ChannelJoinPolicy,
  ChannelMemberStatus,
  ChannelVisibility,
  CommunityRole,
  NotificationLevel,
  PostPolicy,
  Prisma,
} from '../../generated/prisma/client.js';
import { canModerate, canPost } from '../community/community-permissions.js';

export const channelNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Channel not found');

export const postNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Post not found');

export const channelForbidden = (message = 'You do not have permission to do that'): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);

export const channelArchived = (): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'ARCHIVED', 'This channel is archived and read-only');

export const CHANNEL_SELECT = {
  id: true,
  handle: true,
  name: true,
  description: true,
  avatarKey: true,
  visibility: true,
  joinPolicy: true,
  postPolicy: true,
  repliesEnabled: true,
  version: true,
  memberCount: true,
  lastPostAt: true,
  archivedAt: true,
  createdAt: true,
} as const satisfies Prisma.ChannelSelect;

export interface ChannelRow {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarKey: string | null;
  visibility: ChannelVisibility;
  joinPolicy: ChannelJoinPolicy;
  postPolicy: PostPolicy;
  repliesEnabled: boolean;
  version: bigint;
  memberCount: number;
  lastPostAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface MembershipRow {
  role: CommunityRole;
  status: ChannelMemberStatus;
  suspendedUntil: Date | null;
  notificationLevel: NotificationLevel;
  mutedUntil: Date | null;
  lastReadSeq: bigint;
  joinedAt: Date;
}

export const MEMBERSHIP_SELECT = {
  role: true,
  status: true,
  suspendedUntil: true,
  notificationLevel: true,
  mutedUntil: true,
  lastReadSeq: true,
  joinedAt: true,
} as const satisfies Prisma.ChannelMemberSelect;

/** A community channel as seen by one account. */
export interface ChannelAccess {
  channel: ChannelRow;
  viewerId: string;
  /** The viewer's membership row (any status), if any. */
  membership: MembershipRow | null;
  /** ACTIVE membership only. */
  active: boolean;
  role: CommunityRole | null;
}

export function isSuspended(membership: MembershipRow | null, now = new Date()): boolean {
  return Boolean(membership?.suspendedUntil && membership.suspendedUntil > now);
}

/**
 * Authorization for community channels (ADR-032). Private channels — and any
 * channel the viewer is banned from, if private — answer with the same 404 as
 * an unknown ID, so private channels cannot be discovered by probing.
 */
@Injectable()
export class ChannelAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async load(viewerId: string, channelId: string): Promise<ChannelAccess | undefined> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        ...CHANNEL_SELECT,
        members: { where: { userId: viewerId }, select: MEMBERSHIP_SELECT },
      },
    });
    if (!channel) return undefined;
    const { members, ...row } = channel;
    const membership = members[0] ?? null;
    const active = membership?.status === 'ACTIVE';
    return { channel: row, viewerId, membership, active, role: active ? membership.role : null };
  }

  /** Public channels for everyone (unless banned); private channels for active members. */
  async requireReadable(viewerId: string, channelId: string): Promise<ChannelAccess> {
    const access = await this.load(viewerId, channelId);
    if (!access || !this.canRead(access)) throw channelNotFound();
    return access;
  }

  canRead(access: ChannelAccess): boolean {
    if (access.active) return true;
    if (access.membership?.status === 'BANNED') return false;
    return access.channel.visibility === 'PUBLIC';
  }

  /** Active members only (others get 404 for private channels, 403 for public ones). */
  async requireMember(viewerId: string, channelId: string): Promise<ChannelAccess> {
    const access = await this.requireReadable(viewerId, channelId);
    if (!access.active) throw channelForbidden('Join this channel first');
    return access;
  }

  async requireModerator(viewerId: string, channelId: string): Promise<ChannelAccess> {
    const access = await this.requireMember(viewerId, channelId);
    if (!access.role || !canModerate(access.role)) throw channelForbidden();
    return access;
  }

  assertWritable(access: ChannelAccess): void {
    if (access.channel.archivedAt) throw channelArchived();
  }

  /** Posting, replying and reacting: active, not suspended, channel not archived. */
  assertCanParticipate(access: ChannelAccess): void {
    this.assertWritable(access);
    if (!access.active) throw channelForbidden('Join this channel first');
    if (isSuspended(access.membership)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'SUSPENDED',
        'You are suspended from posting in this channel',
      );
    }
  }

  canPostTopLevel(access: ChannelAccess): boolean {
    return access.role !== null && canPost(access.role, access.channel.postPolicy);
  }
}
