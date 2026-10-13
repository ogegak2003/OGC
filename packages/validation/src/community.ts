import { ATTACHMENT_KINDS } from '@ogc/types';
import { z } from 'zod';
import {
  MENTIONS_MAX,
  MESSAGE_TEXT_MAX_LENGTH,
  attachmentNameSchema,
  messageTextSchema,
  mimeTypeSchema,
  uuidSchema,
} from './messaging.js';
import { ogcIdSchema } from './ogc-id.js';
import { REPORT_CATEGORIES, ogcIdInputSchema } from './social.js';

/**
 * Groups, private encrypted channels and community channels (Phase 4). Names and
 * descriptions are server-visible metadata: normalised, stripped of control and bidi
 * characters. See docs/architecture/groups.md and channels.md.
 */

/** Members per group or private encrypted channel (bounded by MLS cost, ADR-033). */
export const GROUP_MEMBER_LIMIT = 32;
/** MLS leaves (devices) per encrypted conversation (ADR-033). */
export const MLS_MAX_LEAVES = 128;
export const COMMUNITY_NAME_MAX_LENGTH = 64;
export const GROUP_DESCRIPTION_MAX_LENGTH = 500;
export const CHANNEL_DESCRIPTION_MAX_LENGTH = 1000;
export const CHANNEL_POST_MAX_LENGTH = MESSAGE_TEXT_MAX_LENGTH;
export const CHANNEL_POST_ATTACHMENTS_MAX = 10;
export const PINNED_POSTS_MAX = 10;
export const INVITE_LINK_MAX_DAYS = 30;
export const INVITE_LINK_MAX_USES = 10_000;
export const INVITATION_TTL_DAYS = 14;
export const MODERATION_REASON_MAX_LENGTH = 500;

/** Control characters other than line feed. */
const CONTROL_EXCEPT_NEWLINE = /(?!\n)\p{Cc}/u;
const BIDI_OVERRIDES = /[‪-‮⁦-⁩]/u;

function singleLine(max: number) {
  return z
    .string()
    .transform((value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(1, 'Required')
        .max(max, `Use at most ${String(max)} characters`)
        .refine(
          (value) => !/\p{Cc}/u.test(value) && !BIDI_OVERRIDES.test(value),
          'Remove unsupported characters',
        ),
    );
}

function multiLine(max: number) {
  return z
    .string()
    .transform((value) =>
      value
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    )
    .pipe(
      z
        .string()
        .max(max, `Use at most ${String(max)} characters`)
        .refine(
          (value) => !CONTROL_EXCEPT_NEWLINE.test(value) && !BIDI_OVERRIDES.test(value),
          'Remove unsupported characters',
        ),
    );
}

export const communityNameSchema = singleLine(COMMUNITY_NAME_MAX_LENGTH);
export const groupDescriptionSchema = multiLine(GROUP_DESCRIPTION_MAX_LENGTH);
export const channelDescriptionSchema = multiLine(CHANNEL_DESCRIPTION_MAX_LENGTH);
export const moderationReasonTextSchema = multiLine(MODERATION_REASON_MAX_LENGTH);

/** Channel handles: 5–32 lower-case letters, digits or underscores, starting with a letter. */
export const CHANNEL_HANDLE_PATTERN = /^[a-z][a-z0-9_]{4,31}$/;
export const channelHandleSchema = z
  .string()
  .max(40)
  .transform((value) => value.trim().toLowerCase().replace(/^@/, ''))
  .pipe(
    z
      .string()
      .regex(
        CHANNEL_HANDLE_PATTERN,
        'Use 5–32 letters, digits or underscores, starting with a letter',
      ),
  );

export const COMMUNITY_ROLES = ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER'] as const;
export const POST_POLICIES = ['ALL_MEMBERS', 'MODERATORS', 'ADMINS'] as const;
export const INVITE_POLICIES = ['ALL_MEMBERS', 'ADMINS'] as const;
export const NOTIFICATION_LEVELS = ['ALL', 'MENTIONS', 'NONE'] as const;
export const CHANNEL_VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;
export const CHANNEL_JOIN_POLICIES = ['OPEN', 'APPROVAL'] as const;

// ---------------------------------------------------------------------------
// Groups and private encrypted channels
// ---------------------------------------------------------------------------

export const createGroupRequestSchema = z.strictObject({
  kind: z.enum(['GROUP', 'CHANNEL']).default('GROUP'),
  name: communityNameSchema,
  description: groupDescriptionSchema.optional(),
  /** Contacts to invite right away (each must accept). */
  invite: z
    .array(ogcIdInputSchema)
    .max(GROUP_MEMBER_LIMIT - 1)
    .optional(),
});

export const updateGroupRequestSchema = z
  .strictObject({
    name: communityNameSchema.optional(),
    description: z.union([groupDescriptionSchema, z.null()]).optional(),
    postPolicy: z.enum(POST_POLICIES).optional(),
    invitePolicy: z.enum(INVITE_POLICIES).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  });

export const inviteMembersRequestSchema = z.strictObject({
  ogcIds: z
    .array(ogcIdInputSchema)
    .min(1)
    .max(GROUP_MEMBER_LIMIT - 1),
});

export const roleChangeRequestSchema = z.strictObject({
  role: z.enum(['ADMIN', 'MODERATOR', 'MEMBER']),
});

export const transferOwnershipRequestSchema = z.strictObject({ ogcId: ogcIdInputSchema });

export const notificationPreferencesSchema = z
  .strictObject({
    level: z.enum(NOTIFICATION_LEVELS).optional(),
    /** Mute until this time; `null` unmutes. */
    mutedUntil: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  })
  .refine((value) => value.level !== undefined || value.mutedUntil !== undefined, {
    message: 'Provide a preference',
  });

export const createInviteLinkRequestSchema = z.strictObject({
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(INVITE_LINK_MAX_DAYS * 24)
    .default(7 * 24),
  maxUses: z.number().int().min(1).max(INVITE_LINK_MAX_USES).optional(),
});

/** Invitation tokens: `ogc_inv_` + 43 base64url characters (256 random bits, ADR-034). */
export const INVITE_TOKEN_PATTERN = /^ogc_inv_[A-Za-z0-9_-]{43}$/;
export const inviteTokenSchema = z.string().regex(INVITE_TOKEN_PATTERN, 'Invalid invitation');

/**
 * Report from inside an end-to-end encrypted conversation. The server cannot read messages,
 * so the reporter explicitly chooses to disclose the decrypted text they saw.
 */
export const conversationReportRequestSchema = z.strictObject({
  category: z.enum(REPORT_CATEGORIES),
  messageId: uuidSchema.optional(),
  reportedOgcId: ogcIdSchema.optional(),
  disclosedText: messageTextSchema.optional(),
  description: multiLine(1000).optional(),
});

// ---------------------------------------------------------------------------
// Community channels (server-readable)
// ---------------------------------------------------------------------------

export const createChannelRequestSchema = z.strictObject({
  handle: channelHandleSchema,
  name: communityNameSchema,
  description: channelDescriptionSchema.optional(),
  visibility: z.enum(CHANNEL_VISIBILITIES).default('PUBLIC'),
  joinPolicy: z.enum(CHANNEL_JOIN_POLICIES).default('OPEN'),
  postPolicy: z.enum(POST_POLICIES).default('ADMINS'),
  repliesEnabled: z.boolean().default(true),
});

export const updateChannelRequestSchema = z
  .strictObject({
    name: communityNameSchema.optional(),
    description: z.union([channelDescriptionSchema, z.null()]).optional(),
    joinPolicy: z.enum(CHANNEL_JOIN_POLICIES).optional(),
    postPolicy: z.enum(POST_POLICIES).optional(),
    repliesEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  });

/** Changing visibility must be explicitly confirmed by the owner (ADR-032). */
export const changeVisibilityRequestSchema = z.strictObject({
  visibility: z.enum(CHANNEL_VISIBILITIES),
  confirm: z.literal(true, { error: 'Confirm the visibility change' }),
});

const postBodySchema = z
  .string()
  .transform((value) => value.normalize('NFC').replace(/\r\n?/g, '\n').trim())
  .pipe(messageTextSchema);

export const channelPostRequestSchema = z
  .strictObject({
    clientPostId: uuidSchema,
    body: postBodySchema.optional(),
    replyToId: uuidSchema.optional(),
    announcement: z.boolean().optional(),
    attachmentIds: z.array(uuidSchema).max(CHANNEL_POST_ATTACHMENTS_MAX).optional(),
    /** Members to notify (OGC IDs); non-members are ignored. */
    mentions: z.array(ogcIdSchema).max(MENTIONS_MAX).optional(),
  })
  .refine(
    (value) =>
      (value.body !== undefined && value.body.length > 0) ||
      (value.attachmentIds !== undefined && value.attachmentIds.length > 0),
    { message: 'A post needs text or an attachment' },
  )
  .refine((value) => !(value.announcement === true && value.replyToId !== undefined), {
    message: 'Replies cannot be announcements',
  });

export const editChannelPostRequestSchema = z.strictObject({
  body: postBodySchema.pipe(z.string().min(1, 'Required')),
});

export const moderationReasonSchema = z.strictObject({
  reason: moderationReasonTextSchema.optional(),
});

export const suspendMemberRequestSchema = z.strictObject({
  hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365),
  reason: moderationReasonTextSchema.optional(),
});

export const resolveReportRequestSchema = z.strictObject({
  outcome: z.enum(['RESOLVED', 'DISMISSED']),
  resolution: moderationReasonTextSchema.optional(),
  /** Also remove the reported post (only with `RESOLVED`). */
  removePost: z.boolean().optional(),
});

export const reportPostRequestSchema = z.strictObject({
  category: z.enum(REPORT_CATEGORIES),
  description: multiLine(1000).optional(),
});

/** Multipart fields of a community channel media upload (the file is server-readable). */
export const channelMediaFieldsSchema = z.strictObject({
  channelId: uuidSchema,
  kind: z.enum(ATTACHMENT_KINDS),
  name: attachmentNameSchema,
  mime: mimeTypeSchema,
});

export const channelFeedQuerySchema = z.strictObject({
  /** Posts with a lower sequence number (older), for paging backwards. */
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  /** Search this channel's posts (server-readable channels only). */
  q: z.string().trim().min(2).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const channelSyncQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const channelMembersQuerySchema = z.strictObject({
  status: z.enum(['ACTIVE', 'PENDING', 'BANNED']).optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const channelSearchQuerySchema = z.strictObject({
  q: z.string().trim().max(64).optional(),
  cursor: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Marks in-app notifications as read: specific IDs, or all of them. */
export const markNotificationsReadSchema = z.union([
  z.strictObject({ ids: z.array(uuidSchema).min(1).max(100) }),
  z.strictObject({ all: z.literal(true) }),
]);

export type CreateGroupRequest = z.input<typeof createGroupRequestSchema>;
export type UpdateGroupRequest = z.input<typeof updateGroupRequestSchema>;
export type CreateInviteLinkRequest = z.input<typeof createInviteLinkRequestSchema>;
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;
export type ChannelPostRequest = z.input<typeof channelPostRequestSchema>;
export type ConversationReportRequest = z.input<typeof conversationReportRequestSchema>;
