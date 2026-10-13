import { ATTACHMENT_KINDS, type AttachmentKind, REACTION_TYPES } from '@ogc/types';
import { z } from 'zod';
import { ogcIdSchema } from './ogc-id.js';
import { ogcIdInputSchema } from './social.js';

/**
 * Request and payload schemas for private messaging (Phase 3). The server
 * validates envelopes and metadata; message content is end-to-end encrypted,
 * so the decrypted payload schema below is enforced by receiving clients.
 */

/** Largest MLS application message (ciphertext) the server accepts. */
export const MESSAGE_CIPHERTEXT_MAX_BYTES = 64 * 1024;
/** Largest MLS commit, GroupInfo or Welcome (they carry the ratchet tree). */
export const MLS_HANDSHAKE_MAX_BYTES = 128 * 1024;
export const KEY_PACKAGE_MAX_BYTES = 4 * 1024;
export const KEY_PACKAGES_PER_UPLOAD_MAX = 50;
export const MESSAGE_TEXT_MAX_LENGTH = 4000;
export const MESSAGE_ATTACHMENTS_MAX = 10;
export const SYNC_PAGE_DEFAULT = 100;
export const SYNC_PAGE_MAX = 200;
export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 100;
/** OGC IDs a group message may mention (declared by the sender; the server never reads text). */
export const MENTIONS_MAX = 20;
export const VOICE_MAX_DURATION_MS = 15 * 60 * 1000;

const MIB = 1024 * 1024;
/** Plaintext size limits per attachment kind (ciphertext adds a 16-byte tag). */
export const ATTACHMENT_MAX_BYTES: Readonly<Record<AttachmentKind, number>> = {
  IMAGE: 10 * MIB,
  VIDEO: 25 * MIB,
  AUDIO: 25 * MIB,
  VOICE: 10 * MIB,
  DOCUMENT: 25 * MIB,
  FILE: 25 * MIB,
};
export const ATTACHMENT_CIPHERTEXT_OVERHEAD = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const uuidSchema = z.string().regex(UUID, 'Invalid identifier');

/** Strict standard base64 with a maximum decoded size. */
export function base64Schema(maxBytes: number) {
  const maxLength = Math.ceil(maxBytes / 3) * 4;
  return z
    .string()
    .min(4)
    .max(maxLength, 'Too large')
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Invalid base64');
}

const counter = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const createConversationRequestSchema = z.strictObject({ ogcId: ogcIdInputSchema });

export const sendMessageRequestSchema = z.strictObject({
  clientMessageId: uuidSchema,
  epoch: counter,
  ciphertext: base64Schema(MESSAGE_CIPHERTEXT_MAX_BYTES),
  replyToId: uuidSchema.optional(),
  /** The source message (must be readable by the sender); its content is re-encrypted client-side. */
  forwardedFromId: uuidSchema.optional(),
  attachmentIds: z.array(uuidSchema).max(MESSAGE_ATTACHMENTS_MAX).optional(),
  /** Group members mentioned in the (encrypted) text, for notifications only. */
  mentions: z.array(ogcIdSchema).max(MENTIONS_MAX).optional(),
});

export const editMessageRequestSchema = z.strictObject({
  epoch: counter,
  ciphertext: base64Schema(MESSAGE_CIPHERTEXT_MAX_BYTES),
});

export const deleteMessageQuerySchema = z.strictObject({
  scope: z.enum(['everyone', 'self']),
});

export const reactionTypeSchema = z.enum(REACTION_TYPES);

export const receiptRequestSchema = z.strictObject({ seq: counter.min(1) });

export const syncQuerySchema = z.strictObject({
  after: counter.default(0),
  limit: z.coerce.number().int().min(1).max(SYNC_PAGE_MAX).default(SYNC_PAGE_DEFAULT),
});

export const historyQuerySchema = z
  .strictObject({
    before: counter.min(1).optional(),
    after: counter.optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_DEFAULT),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    message: 'Use either before or after, not both',
  });

export const conversationChangesQuerySchema = z.strictObject({
  since: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const registerDeviceKeyRequestSchema = z.strictObject({
  signaturePublicKey: base64Schema(32).refine(
    // 32 bytes encode to 43 characters plus exactly one padding character.
    (value) => value.length === 44 && value.endsWith('=') && !value.endsWith('=='),
    'Expected 32 bytes',
  ),
});

export const uploadKeyPackagesRequestSchema = z.strictObject({
  keyPackages: z.array(base64Schema(KEY_PACKAGE_MAX_BYTES)).min(1).max(KEY_PACKAGES_PER_UPLOAD_MAX),
});

export const claimKeyPackagesRequestSchema = z.strictObject({
  deviceKeyIds: z.array(uuidSchema).min(1).max(50),
});

export const commitRequestSchema = z.strictObject({
  epoch: counter,
  commit: base64Schema(MLS_HANDSHAKE_MAX_BYTES),
  groupInfo: base64Schema(MLS_HANDSHAKE_MAX_BYTES),
  welcome: base64Schema(MLS_HANDSHAKE_MAX_BYTES).optional(),
});

export const attachmentUploadFieldsSchema = z.strictObject({
  conversationId: uuidSchema,
  kind: z.enum(ATTACHMENT_KINDS),
});

export const pushTokenRequestSchema = z.strictObject({
  provider: z.enum(['EXPO', 'FCM', 'APNS']),
  token: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\x21-\x7e]+$/, 'Invalid token'),
});

// Realtime (Socket.IO) client events.
export const typingEventSchema = z.strictObject({ conversationId: uuidSchema });
export const presenceSubscriptionSchema = z.strictObject({
  ogcIds: z.array(ogcIdSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Decrypted message payload (validated by receiving clients, never by the server).
// ---------------------------------------------------------------------------

/** Control characters other than tab and line feed. */
const DISALLOWED_CONTROL = /(?![\t\n])\p{Cc}/u;
const BIDI_OVERRIDES = /[‪-‮⁦-⁩]/u;

export const messageTextSchema = z
  .string()
  .max(MESSAGE_TEXT_MAX_LENGTH)
  .refine((value) => !DISALLOWED_CONTROL.test(value), 'Unsupported characters')
  .refine((value) => !BIDI_OVERRIDES.test(value), 'Unsupported characters');

/** Display-safe file name: no path separators, control characters or bidi overrides. */
export const attachmentNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[/\\]/.test(value) &&
      !DISALLOWED_CONTROL.test(value) &&
      !/[\t\n]/.test(value) &&
      !BIDI_OVERRIDES.test(value) &&
      value !== '.' &&
      value !== '..',
    'Invalid file name',
  );

export const mimeTypeSchema = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, 'Invalid media type');

export const attachmentDescriptorSchema = z.strictObject({
  id: uuidSchema,
  kind: z.enum(ATTACHMENT_KINDS),
  name: attachmentNameSchema,
  mime: mimeTypeSchema,
  /** Plaintext size in bytes. */
  size: z.number().int().positive(),
  key: base64Schema(32),
  nonce: base64Schema(24),
  digest: base64Schema(32),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
  durationMs: z.number().int().positive().max(VOICE_MAX_DURATION_MS).optional(),
  /** Voice-message amplitude preview, 0–255. */
  waveform: z.array(z.number().int().min(0).max(255)).max(64).optional(),
});

export const messagePayloadSchema = z
  .strictObject({
    v: z.literal(1),
    text: messageTextSchema.optional(),
    attachments: z.array(attachmentDescriptorSchema).max(MESSAGE_ATTACHMENTS_MAX).optional(),
  })
  .refine(
    (p) =>
      (p.text !== undefined && p.text.trim().length > 0) ||
      (p.attachments !== undefined && p.attachments.length > 0),
    'A message needs text or an attachment',
  )
  .refine(
    (p) => (p.attachments ?? []).every((a) => a.size <= ATTACHMENT_MAX_BYTES[a.kind]),
    'Attachment too large',
  );

export type MessagePayload = z.infer<typeof messagePayloadSchema>;
export type AttachmentDescriptor = z.infer<typeof attachmentDescriptorSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type CommitRequest = z.infer<typeof commitRequestSchema>;
