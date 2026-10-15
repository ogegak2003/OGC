import type {
  CallEngine,
  CallMediaPlatform,
  ConnectionState,
  MessagingClient,
  RealtimeConnection,
  RealtimeOptions,
} from '@ogc/messaging';
import type { ConversationView, OgcId, PresenceState, ServerToClientEvents } from '@ogc/types';
import { createContext, useContext } from 'react';

/** The engine surface the UI uses (the real `MessagingClient`, or a fake in tests). */
export type MessagingEngine = Pick<
  MessagingClient,
  | 'ogcId'
  | 'deviceKeyId'
  | 'subscribe'
  | 'start'
  | 'conversations'
  | 'conversation'
  | 'refreshConversations'
  | 'openDirect'
  | 'messages'
  | 'syncConversation'
  | 'syncAll'
  | 'send'
  | 'edit'
  | 'deleteForEveryone'
  | 'deleteForMe'
  | 'react'
  | 'markRead'
  | 'forward'
  | 'uploadAttachment'
  | 'openAttachment'
  | 'search'
  | 'safetyNumber'
  | 'flushOutbox'
  | 'discardFailed'
  | 'handleRealtime'
  | 'wipe'
  | 'timeline'
  | 'forgetConversation'
  | 'peerKeyStatus'
  | 'acknowledgePeerKeys'
  | 'markPeerVerified'
>;

export type RealtimeLink = Pick<
  RealtimeConnection,
  'connect' | 'disconnect' | 'typing' | 'subscribePresence' | 'unsubscribePresence' | 'callRequest'
>;

export interface MessagingDependencies {
  createEngine: (ogcId: string) => Promise<MessagingEngine>;
  createRealtime: (
    options: Pick<RealtimeOptions, 'onState' | 'onUnauthorized'>,
    onEvent: <E extends keyof ServerToClientEvents>(
      event: E,
      payload: Parameters<ServerToClientEvents[E]>[0],
    ) => void,
    onReconnect: () => void,
  ) => RealtimeLink;
  destroyLocalData: (ogcId: string) => Promise<void>;
  /** WebRTC for calls; undefined where the browser cannot make calls (e.g. not HTTPS). */
  createCallMedia?: () => CallMediaPlatform | undefined;
}

export interface MessagingContextValue {
  status: 'idle' | 'starting' | 'ready' | 'error';
  error: string | undefined;
  connection: ConnectionState;
  engine: MessagingEngine | undefined;
  conversations: ConversationView[];
  /** Bumped whenever a conversation's messages change, to re-read local state. */
  messageRevision: Record<string, number>;
  /** Conversations where the other person is typing right now. */
  typing: Record<string, boolean>;
  presence: Record<string, PresenceState>;
  unreadTotal: number;
  /** Unread in-app notifications (invitations, mentions, announcements…). */
  notificationsUnread: number;
  setNotificationsUnread: (count: number) => void;
  /** Bumped when invitations change (a new one arrived, one was revoked). */
  invitationsRevision: number;
  /** Bumped per community channel on realtime channel events, to refetch. */
  channelRevision: Record<string, number>;
  setTyping: (conversationId: string, typing: boolean) => void;
  watchPresence: (ogcIds: OgcId[]) => void;
  /** One-to-one calls on this device (available once the realtime connection exists). */
  calls: CallEngine | undefined;
  /** Bumped whenever a call ends, to refresh call history. */
  callsRevision: number;
  /** Starts the messaging engine again after `status: 'error'`. */
  retry: () => void;
}

export const MessagingContext = createContext<MessagingContextValue | undefined>(undefined);

export function useMessaging(): MessagingContextValue {
  const value = useContext(MessagingContext);
  if (!value) throw new Error('useMessaging must be used inside <MessagingProvider>');
  return value;
}
