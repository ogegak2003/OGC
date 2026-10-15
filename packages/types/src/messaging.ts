import type {
  ChannelView,
  CommunityRole,
  ConversationEventView,
  GroupInfoView,
  NotificationView,
  ReceivedInvitationView,
} from './community.js';
import type { CallEndReason, CallSetup, CallSignal, CallView } from './calls.js';
import type { OgcId } from './identity.js';
import type { ProfileSummary } from './social.js';

/**
 * Private messaging contract (Phase 3). Message content is end-to-end
 * encrypted with MLS: every `ciphertext` is a base64 MLS message that only the
 * participants' devices can decrypt. Sequence numbers and versions are
 * per-conversation counters (safe integers).
 */

/** DIRECT = two people; GROUP = private group; CHANNEL = private encrypted channel. */
export type ConversationType = 'DIRECT' | 'GROUP' | 'CHANNEL';

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
  /** DIRECT: the other participant; null for groups and channels. */
  peer: ProfileSummary | null;
  /** Groups and encrypted channels: name, photo, the viewer's role and policies. */
  group: GroupInfoView | null;
  /** Latest change counter; a client that has synced to this version is up to date. */
  version: number;
  lastActivityAt: string;
  lastMessage: MessageSummary | null;
  unreadCount: number;
  myLastReadSeq: number;
  /** DIRECT: the peer's read mark. Groups: the lowest read mark of the other members ("read by everyone"). */
  peerLastReadSeq: number;
  peerLastDeliveredSeq: number;
  /** DIRECT: the viewer blocked the peer. Being blocked by the peer is never revealed. */
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
  | { type: 'hidden'; version: number; messageId: string }
  /** Membership and settings changes in groups and channels (never content). */
  | { type: 'event'; version: number; event: ConversationEventView };

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

  // Groups and private encrypted channels (sync recovers anything missed).
  'group.created': (payload: { conversation: ConversationView }) => void;
  'group.updated': (payload: { conversationId: string; version: number }) => void;
  'group.member_joined': (payload: {
    conversationId: string;
    version: number;
    ogcId: OgcId;
  }) => void;
  'group.member_left': (payload: { conversationId: string; version: number; ogcId: OgcId }) => void;
  /** Also sent to the removed person's devices, which then erase the conversation. */
  'group.member_removed': (payload: {
    conversationId: string;
    version: number;
    ogcId: OgcId;
  }) => void;
  'group.role_changed': (payload: {
    conversationId: string;
    version: number;
    ogcId: OgcId;
    role: CommunityRole;
  }) => void;
  /** Sent to the invitee. */
  'group.invitation_created': (payload: { invitation: ReceivedInvitationView }) => void;
  'group.invitation_revoked': (payload: { invitationId: string; conversationId: string }) => void;
  /** The group was deleted by its owner: erase it locally. */
  'group.deleted': (payload: { conversationId: string }) => void;

  // Community channels. Post events carry IDs only; clients fetch personalised views via sync.
  'channel.created': (payload: { channel: ChannelView }) => void;
  'channel.updated': (payload: { channelId: string; version: number }) => void;
  'channel.member_joined': (payload: { channelId: string; ogcId: OgcId }) => void;
  'channel.member_left': (payload: { channelId: string; ogcId: OgcId }) => void;
  'channel.post_created': (payload: { channelId: string; postId: string; version: number }) => void;
  'channel.post_updated': (payload: { channelId: string; postId: string; version: number }) => void;
  'channel.post_deleted': (payload: { channelId: string; postId: string; version: number }) => void;
  'channel.post_pinned': (payload: {
    channelId: string;
    postId: string;
    version: number;
    pinned: boolean;
  }) => void;
  'channel.announcement_created': (payload: {
    channelId: string;
    postId: string;
    version: number;
  }) => void;
  /** The viewer is no longer a member (left, removed, banned, or the channel was deleted). */
  'channel.access_revoked': (payload: { channelId: string }) => void;

  'community.notification': (payload: { notification: NotificationView }) => void;

  // One-to-one calls (Phase 6). Signaling only; media flows between the two devices.
  /** To every device of the callee. */
  'call.incoming': (payload: { call: CallView }) => void;
  /** To the caller's device: the callee answered on one device, so send the offer now. */
  'call.accepted': (payload: { callId: string }) => void;
  /** To the callee's other devices: stop ringing. */
  'call.answered_elsewhere': (payload: { callId: string }) => void;
  /** From the other device in the call. */
  'call.signal': (payload: { callId: string; signal: CallSignal }) => void;
  /** To every device of both participants (each sees its own view of the call). */
  'call.ended': (payload: { call: CallView; reason: CallEndReason }) => void;
}

export type RealtimeAck<T> = (
  response: { ok: true; data: T } | { ok: false; error: string },
) => void;

export interface ClientToServerEvents {
  'typing.start': (payload: { conversationId: string }) => void;
  'typing.stop': (payload: { conversationId: string }) => void;
  'presence.subscribe': (payload: { ogcIds: OgcId[] }, ack: RealtimeAck<PresenceView[]>) => void;
  'presence.unsubscribe': (payload: { ogcIds: OgcId[] }) => void;
  'call.start': (
    payload: { conversationId: string; media: CallView['media'] },
    ack: RealtimeAck<CallSetup>,
  ) => void;
  'call.accept': (payload: { callId: string }, ack: RealtimeAck<CallSetup>) => void;
  'call.decline': (payload: { callId: string }, ack: RealtimeAck<null>) => void;
  'call.cancel': (payload: { callId: string }, ack: RealtimeAck<null>) => void;
  'call.end': (
    payload: { callId: string; reason?: 'hangup' | 'failed' },
    ack: RealtimeAck<null>,
  ) => void;
  'call.signal': (payload: { callId: string; signal: CallSignal }, ack: RealtimeAck<null>) => void;
  /** Media is flowing: starts the call duration (first report wins). */
  'call.connected': (payload: { callId: string }, ack: RealtimeAck<null>) => void;
  /** The account's open call, if any — to restore the call screen after a reconnect. */
  'call.sync': (
    payload: Record<string, never>,
    ack: RealtimeAck<{ call: CallView; onThisDevice: boolean } | null>,
  ) => void;
}

export type ServerEventName = keyof ServerToClientEvents;
export type ClientEventName = keyof ClientToServerEvents;
