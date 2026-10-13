import type { OgcId } from './identity.js';
import type { AttachmentKind, ReactionType } from './messaging.js';
import type { ProfileSummary, ReportCategory, ReportStatus } from './social.js';

/**
 * Groups, private encrypted channels and community channels (Phase 4).
 *
 * - **Groups** and **private encrypted channels** are conversations (`GROUP`, `CHANNEL`)
 *   whose messages are end-to-end encrypted with MLS. Their name, description, photo and
 *   membership are server-visible metadata.
 * - **Community channels** are server-readable (NOT end-to-end encrypted) and built for
 *   larger audiences, discovery and moderation.
 */

export type CommunityRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
export type PostPolicy = 'ALL_MEMBERS' | 'MODERATORS' | 'ADMINS';
export type InvitePolicy = 'ALL_MEMBERS' | 'ADMINS';
export type NotificationLevel = 'ALL' | 'MENTIONS' | 'NONE';
export type EncryptedCommunityKind = 'GROUP' | 'CHANNEL';

/** Group / encrypted-channel details as seen by a member. */
export interface GroupInfoView {
  kind: EncryptedCommunityKind;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  myRole: CommunityRole;
  memberCount: number;
  postPolicy: PostPolicy;
  invitePolicy: InvitePolicy;
  archived: boolean;
  /** Whether the viewer may post under the current policy. */
  canPost: boolean;
}

export interface GroupMemberView {
  profile: ProfileSummary;
  role: CommunityRole;
  joinedAt: string;
}

/** A pending personal invitation, as seen by the invitee. */
export interface ReceivedInvitationView {
  id: string;
  conversationId: string;
  kind: EncryptedCommunityKind;
  name: string;
  avatarUrl: string | null;
  memberCount: number;
  inviter: ProfileSummary | null;
  createdAt: string;
  expiresAt: string;
}

/** Invitations sent from a group, as seen by its members with invite rights. */
export interface SentInvitationView {
  id: string;
  invitee: ProfileSummary;
  inviter: ProfileSummary | null;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
}

export interface InviteResult {
  /** OGC IDs that were invited (others were skipped without saying why). */
  invited: OgcId[];
}

/** An invitation link. The token is returned only once, when the link is created. */
export interface InviteLinkView {
  id: string;
  createdBy: ProfileSummary | null;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
}

export interface CreatedInviteLink extends InviteLinkView {
  /** `ogc_inv_…` — shown once; only its hash is stored. */
  token: string;
}

/** What an invitation link leads to, before joining. */
export interface InvitePreview {
  target: 'GROUP' | 'CHANNEL' | 'COMMUNITY_CHANNEL';
  /** Conversation ID (groups, encrypted channels) or channel ID (community channels). */
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  memberCount: number;
  alreadyMember: boolean;
  requiresApproval: boolean;
  /** True for groups and encrypted channels; community channels are server-readable. */
  endToEndEncrypted: boolean;
}

export interface JoinResult {
  target: InvitePreview['target'];
  id: string;
  /** `PENDING` when the community requires approval. */
  status: 'JOINED' | 'PENDING';
}

export type ConversationEventType =
  | 'CREATED'
  | 'MEMBER_JOINED'
  | 'MEMBER_LEFT'
  | 'MEMBER_REMOVED'
  | 'ROLE_CHANGED'
  | 'OWNERSHIP_TRANSFERRED'
  | 'DETAILS_UPDATED'
  | 'MESSAGE_REMOVED'
  | 'ARCHIVED'
  | 'UNARCHIVED';

/** A membership or settings change shown in the timeline ("Ada added Grace"). Never content. */
export interface ConversationEventView {
  id: string;
  type: ConversationEventType;
  actor: OgcId | null;
  subject: OgcId | null;
  /** e.g. `{ role: 'ADMIN' }`, `{ fields: ['name'] }`. */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * A report about an end-to-end encrypted conversation, for OGC staff. `disclosedText`
 * is what the reporter explicitly chose to share; the server cannot read messages.
 */
export interface ConversationReportView {
  id: string;
  conversationId: string | null;
  conversationType: 'DIRECT' | 'GROUP' | 'CHANNEL' | null;
  messageId: string | null;
  reporterOgcId: OgcId | null;
  reportedOgcId: OgcId | null;
  category: ReportCategory;
  disclosedText: string | null;
  description: string | null;
  status: ReportStatus;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Community channels (server-readable)
// ---------------------------------------------------------------------------

export type ChannelVisibility = 'PUBLIC' | 'PRIVATE';
export type ChannelJoinPolicy = 'OPEN' | 'APPROVAL';
/** Who may write top-level posts (replies follow `repliesEnabled`). */
export type ChannelPostPolicy = PostPolicy;
export type ChannelMemberStatus = 'ACTIVE' | 'PENDING' | 'BANNED';

export interface ChannelMembershipView {
  role: CommunityRole;
  status: ChannelMemberStatus;
  suspendedUntil: string | null;
  notificationLevel: NotificationLevel;
  mutedUntil: string | null;
  lastReadSeq: number;
}

export interface ChannelView {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  visibility: ChannelVisibility;
  joinPolicy: ChannelJoinPolicy;
  postPolicy: ChannelPostPolicy;
  repliesEnabled: boolean;
  memberCount: number;
  version: number;
  archived: boolean;
  lastPostAt: string | null;
  createdAt: string;
  /** Always false: community channel content is readable by OGC (for moderation and search). */
  endToEndEncrypted: false;
  membership: ChannelMembershipView | null;
  unreadCount: number;
  canPost: boolean;
  canReply: boolean;
  canModerate: boolean;
}

export interface ChannelAttachmentView {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface ChannelReactionSummary {
  reaction: ReactionType;
  count: number;
  mine: boolean;
}

export interface ChannelPostView {
  id: string;
  channelId: string;
  seq: number;
  version: number;
  author: ProfileSummary | null;
  clientPostId: string;
  /** Null when deleted, or removed by moderators (moderators still see `removedBody`). */
  body: string | null;
  replyToId: string | null;
  replyCount: number;
  announcement: boolean;
  pinnedAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  removed: boolean;
  /** Only for moderators reviewing a removed post. */
  removedBody?: string | null;
  createdAt: string;
  reactions: ChannelReactionSummary[];
  attachments: ChannelAttachmentView[];
}

export interface ChannelPostPage {
  items: ChannelPostView[];
  nextCursor: string | null;
}

export interface ChannelSyncPage {
  items: ChannelPostView[];
  version: number;
  hasMore: boolean;
}

export interface ChannelMemberView {
  profile: ProfileSummary;
  role: CommunityRole;
  status: ChannelMemberStatus;
  suspendedUntil: string | null;
  joinedAt: string;
}

export type ModerationActionType =
  | 'REMOVE_POST'
  | 'RESTORE_POST'
  | 'SUSPEND'
  | 'UNSUSPEND'
  | 'BAN'
  | 'UNBAN'
  | 'REMOVE_MEMBER'
  | 'ROLE_CHANGED'
  | 'APPROVE_MEMBER'
  | 'REJECT_MEMBER'
  | 'RESOLVE_REPORT'
  | 'DISMISS_REPORT'
  | 'PIN_POST'
  | 'UNPIN_POST'
  | 'VISIBILITY_CHANGED'
  | 'OWNERSHIP_TRANSFERRED'
  | 'ARCHIVED'
  | 'UNARCHIVED';

export interface ModerationActionView {
  id: string;
  action: ModerationActionType;
  moderator: ProfileSummary | null;
  target: ProfileSummary | null;
  postId: string | null;
  reason: string | null;
  until: string | null;
  createdAt: string;
}

export interface ChannelPostReportView {
  id: string;
  post: ChannelPostView;
  reporter: ProfileSummary | null;
  category: ReportCategory;
  description: string | null;
  status: ReportStatus;
  resolution: string | null;
  createdAt: string;
}

export interface VisibilityChangeResult {
  channel: ChannelView;
  /** Plain-language consequences the owner confirmed. */
  consequences: string[];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'GROUP_INVITATION'
  | 'GROUP_MEMBER_ADDED'
  | 'GROUP_MEMBER_REMOVED'
  | 'GROUP_ROLE_CHANGED'
  | 'GROUP_DETAILS_CHANGED'
  | 'MENTION'
  | 'CHANNEL_ANNOUNCEMENT'
  | 'CHANNEL_ROLE_CHANGED'
  | 'CHANNEL_JOIN_REQUEST'
  | 'CHANNEL_REQUEST_APPROVED'
  | 'CHANNEL_MEMBER_REMOVED'
  | 'MODERATION_RESULT'
  | 'INVITATION_EXPIRED';

/** In-app notification. `data` holds IDs and public names only — never message content. */
export interface NotificationView {
  id: string;
  type: NotificationType;
  data: Record<string, string | number | boolean | null>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  unread: number;
}

export interface NotificationPreferences {
  level: NotificationLevel;
  mutedUntil: string | null;
}
