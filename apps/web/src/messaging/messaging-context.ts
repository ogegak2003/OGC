import type {
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
>;

export type RealtimeLink = Pick<
  RealtimeConnection,
  'connect' | 'disconnect' | 'typing' | 'subscribePresence' | 'unsubscribePresence'
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
}

export const MessagingContext = createContext<MessagingContextValue | undefined>(undefined);

export function useMessaging(): MessagingContextValue {
  const value = useContext(MessagingContext);
  if (!value) throw new Error('useMessaging must be used inside <MessagingProvider>');
  return value;
}
