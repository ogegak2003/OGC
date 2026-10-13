import type { OgcId } from './identity.js';
import type { ProfileSummary } from './social.js';

/**
 * Private messaging contract (Phase 3). Message content is end-to-end
 * encrypted with MLS: every `ciphertext` is a base64 MLS message that only the
 * participants' devices can decrypt. Sequence numbers and versions are
 * per-conversation counters (safe integers).
 */

export type ConversationType = 'DIRECT';

/**
 * Delivery state of the viewer's own message. `PENDING` exists only on the
 * sending device (created locally, not yet accepted by the server).
 */
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ';

/** The fixed reaction set. Reaction types are visible to the server (ADR-022). */
export const REACTION_TYPES = ['thumbs_up', 'heart', 'joy', 'wow', 'sad', 'pray'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export const REACTION_EMOJI: Readonly<Record<ReactionType, string>> = {
  thumbs_up: '👍',
  heart: '❤️',
  joy: '😂',
  wow: '😮',
  sad: '😢',
  pray: '🙏',
};

export const ATTACHMENT_KINDS = ['IMAGE', 'VIDEO', 'AUDIO', 'VOICE', 'DOCUMENT', 'FILE'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Server-side metadata of the most recent message (content previews are decrypted on device). */
export interface MessageSummary {
  id: string;
  seq: number;
  senderOgcId: OgcId | null;
  createdAt: string;
  deleted: boolean;
}

export interface ConversationView {
  id: string;
  type: ConversationType;
  /** The other participant. */
  peer: ProfileSummary;
  /** Latest change counter; a client that has synced to this version is up to date. */
  version: number;
  lastActivityAt: string;
  lastMessage: MessageSummary | null;
  unreadCount: number;
  myLastReadSeq: number;
  peerLastReadSeq: number;
  peerLastDeliveredSeq: number;
  /** The viewer blocked the peer. Being blocked by the peer is never revealed. */
  blockedByMe: boolean;
  mls: { epoch: number; ready: boolean };
  createdAt: string;
}

export interface ReactionView {
  reaction: ReactionType;
  ogcId: OgcId;
}

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  /** Ciphertext size in bytes. */
  size: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  seq: number;
  version: number;
  /** Server routing metadata only; clients authenticate the sender from the MLS ciphertext. */
  sender: { ogcId: OgcId | null; deviceKeyId: string | null };
  clientMessageId: string;
  epoch: number;
  /** base64 MLS PrivateMessage; null once deleted for everyone. */
  ciphertext: string | null;
  replyToId: string | null;
  forwarded: boolean;
  revision: number;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: ReactionView[];
  attachments: AttachmentRef[];
}

/** One entry of a conversation's change log, ordered by `version`. */
export type SyncItem =
  | { type: 'message'; version: number; message: MessageView }
  | { type: 'commit'; version: number; epoch: number; commit: string }
  | { type: 'hidden'; version: number; messageId: string };

export interface SyncPage {
  items: SyncItem[];
  /** Pass back as `after` to continue; equals the highest version covered. */
  version: number;
  hasMore: boolean;
}

export interface MessagePage {
  items: MessageView[];
  hasMore: boolean;
}

/** Conversations changed since a cursor (reconnect / new device synchronization). */
export interface ConversationChanges {
  items: ConversationView[];
  cursor: string;
  hasMore: boolean;
}

/**
 * A device in the encryption directory: what clients authenticate MLS members
 * against. Inactive devices (logged out or expired) are listed for a while so
 * past membership changes still verify; clients remove them from groups and
 * the server never accepts them in a new group state.
 */
export interface DirectoryDevice {
  ogcId: OgcId;
  deviceKeyId: string;
  /** base64 Ed25519 public key. */
  signaturePublicKey: string;
  active: boolean;
  createdAt: string;
}

export interface DeviceKeyView {
  deviceKeyId: string;
  keyPackagesAvailable: number;
}

export interface ClaimedKeyPackage {
  deviceKeyId: string;
  keyPackage: string;
}

/** The delivery service's view of a conversation's MLS group. */
export interface MlsGroupView {
  epoch: number;
  /** base64 MLS GroupInfo for the current epoch (enables external joins), if the group exists. */
  groupInfo: string | null;
  /** Device key IDs currently in the group's ratchet tree. */
  members: string[];
}

export interface WelcomeView {
  id: string;
  conversationId: string;
  epoch: number;
  welcome: string;
}

export interface CommitAccepted {
  epoch: number;
  version: number;
}

export interface AttachmentUploadResult {
  id: string;
  size: number;
}

export type PushProviderName = 'EXPO' | 'FCM' | 'APNS';

/** Presence is approximate and only shared between people who have a conversation. */
export type PresenceState = 'ONLINE' | 'OFFLINE';

export interface PresenceView {
  ogcId: OgcId;
  state: PresenceState;
}

// ---------------------------------------------------------------------------
// Realtime (Socket.IO) contract, version 1.
// ---------------------------------------------------------------------------

/** Socket.IO path (proxied with the REST API) and versioned namespace. */
export const REALTIME_PATH = '/api/realtime';
export const REALTIME_NAMESPACE = '/v1';

export interface ServerToClientEvents {
  'conversation.created': (payload: { conversation: ConversationView }) => void;
  'conversation.updated': (payload: { conversationId: string; version: number }) => void;
  'message.created': (payload: { message: MessageView }) => void;
  'message.updated': (payload: { message: MessageView }) => void;
  'message.deleted': (payload: { message: MessageView }) => void;
  'message.reaction': (payload: {
    conversationId: string;
    messageId: string;
    version: number;
    reactions: ReactionView[];
  }) => void;
  'message.hidden': (payload: {
    conversationId: string;
    messageId: string;
    version: number;
  }) => void;
  'message.delivered': (payload: { conversationId: string; ogcId: OgcId; seq: number }) => void;
  'message.read': (payload: { conversationId: string; ogcId: OgcId; seq: number }) => void;
  'message.typing': (payload: { conversationId: string; ogcId: OgcId; typing: boolean }) => void;
  'presence.updated': (payload: PresenceView) => void;
  'mls.commit': (payload: { conversationId: string; epoch: number; version: number }) => void;
  'mls.welcome': (payload: { conversationId: string }) => void;
  /** A participant's set of encryption devices changed: reconcile group membership. */
  'devices.changed': (payload: { conversationId: string }) => void;
}

export type RealtimeAck<T> = (
  response: { ok: true; data: T } | { ok: false; error: string },
) => void;

export interface ClientToServerEvents {
  'typing.start': (payload: { conversationId: string }) => void;
  'typing.stop': (payload: { conversationId: string }) => void;
  'presence.subscribe': (payload: { ogcIds: OgcId[] }, ack: RealtimeAck<PresenceView[]>) => void;
  'presence.unsubscribe': (payload: { ogcIds: OgcId[] }) => void;
}

export type ServerEventName = keyof ServerToClientEvents;
export type ClientEventName = keyof ClientToServerEvents;
