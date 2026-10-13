import type {
  ConnectionState,
  MessagingClient,
  RealtimeConnection,
  RealtimeOptions,
} from '@ogc/messaging';
import type { ConversationView, OgcId, PresenceState, ServerToClientEvents } from '@ogc/types';
import { createContext, useContext } from 'react';
import type { ApiClient } from '../api/client';

/** The engine surface the screens use (the real `MessagingClient`, or a fake in tests). */
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
>;

export type RealtimeLink = Pick<
  RealtimeConnection,
  'connect' | 'disconnect' | 'typing' | 'subscribePresence' | 'unsubscribePresence'
>;

export interface MessagingDependencies {
  createEngine: (ogcId: string, client: ApiClient) => Promise<MessagingEngine>;
  createRealtime: (
    client: ApiClient,
    options: Pick<RealtimeOptions, 'onState'>,
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
  messageRevision: Record<string, number>;
  typing: Record<string, boolean>;
  presence: Record<string, PresenceState>;
  unreadTotal: number;
  setTyping: (conversationId: string, typing: boolean) => void;
  watchPresence: (ogcIds: OgcId[]) => void;
}

export const MessagingContext = createContext<MessagingContextValue | undefined>(undefined);

export function useMessaging(): MessagingContextValue {
  const value = useContext(MessagingContext);
  if (!value) throw new Error('useMessaging must be used inside <MessagingProvider>');
  return value;
}
