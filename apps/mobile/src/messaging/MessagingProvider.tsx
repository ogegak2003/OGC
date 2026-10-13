import type { ConnectionState } from '@ogc/messaging';
import type { ConversationView, OgcId, PresenceState, ServerToClientEvents } from '@ogc/types';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import {
  type MessagingContextValue,
  MessagingContext,
  type MessagingDependencies,
  type MessagingEngine,
  type RealtimeLink,
} from './messaging-context';
import { nativeDependencies } from './native-dependencies';

const TYPING_DISPLAY_MS = 8_000;

interface Session {
  ogcId: string;
  status: 'ready' | 'error';
  engine: MessagingEngine | undefined;
  error: string | undefined;
}

/**
 * Runs the end-to-end encrypted messaging engine for the signed-in account.
 * Catches up on reconnect and whenever the app returns to the foreground.
 * Signing out deletes this device's messaging data and its sealing key.
 */
export function MessagingProvider({
  children,
  dependencies = nativeDependencies,
}: {
  children: ReactNode;
  dependencies?: MessagingDependencies;
}) {
  const { state, client } = useAuth();
  const ogcId =
    state.status === 'signed-in' && state.account.accountStatus === 'ACTIVE'
      ? state.account.ogcId
      : undefined;
  const [session, setSession] = useState<Session>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [messageRevision, setMessageRevision] = useState<Record<string, number>>({});
  const [typing, setTypingState] = useState<Record<string, boolean>>({});
  const [presence, setPresence] = useState<Record<string, PresenceState>>({});
  const [notificationsUnread, setNotificationsUnread] = useState(0);
  const [invitationsRevision, setInvitationsRevision] = useState(0);
  const [channelRevision, setChannelRevision] = useState<Record<string, number>>({});
  const realtime = useRef<RealtimeLink | undefined>(undefined);
  const lastAccount = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (state.status === 'signed-out' && lastAccount.current) {
      const previous = lastAccount.current;
      lastAccount.current = undefined;
      void dependencies.destroyLocalData(previous).catch(() => undefined);
    }
    if (ogcId) lastAccount.current = ogcId;
  }, [state.status, ogcId, dependencies]);

  useEffect(() => {
    if (!ogcId) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let unsubscribe: (() => void) | undefined;
    let link: RealtimeLink | undefined;
    let instance: MessagingEngine | undefined;

    const onEvent = <E extends keyof ServerToClientEvents>(
      event: E,
      payload: Parameters<ServerToClientEvents[E]>[0],
    ): void => {
      if (event === 'message.typing') {
        const update = payload as Parameters<ServerToClientEvents['message.typing']>[0];
        const existing = timers.get(update.conversationId);
        if (existing) clearTimeout(existing);
        setTypingState((current) => ({ ...current, [update.conversationId]: update.typing }));
        if (update.typing) {
          timers.set(
            update.conversationId,
            setTimeout(() => {
              setTypingState((current) => ({ ...current, [update.conversationId]: false }));
            }, TYPING_DISPLAY_MS),
          );
        }
        return;
      }
      if (event === 'presence.updated') {
        const update = payload as Parameters<ServerToClientEvents['presence.updated']>[0];
        setPresence((current) => ({ ...current, [update.ogcId]: update.state }));
        return;
      }
      if (event === 'message.created') {
        const { message } = payload as Parameters<ServerToClientEvents['message.created']>[0];
        setTypingState((current) => ({ ...current, [message.conversationId]: false }));
      }
      instance?.handleRealtime(event, payload);
    };

    const start = async (): Promise<void> => {
      try {
        const engine = await dependencies.createEngine(ogcId, client);
        instance = engine;
        if (isCancelled()) return;
        unsubscribe = engine.subscribe((event) => {
          if (event.type === 'conversations') setConversations(engine.conversations());
          if (event.type === 'notification') setNotificationsUnread((n) => n + 1);
          if (event.type === 'invitations') setInvitationsRevision((n) => n + 1);
          if (event.type === 'channel') {
            setChannelRevision((revisions) => ({
              ...revisions,
              [event.channelId]: (revisions[event.channelId] ?? 0) + 1,
            }));
          }
          if (event.type === 'messages') {
            setMessageRevision((current) => ({
              ...current,
              [event.conversationId]: (current[event.conversationId] ?? 0) + 1,
            }));
          }
        });
        await engine.start();
        if (isCancelled()) return;
        setConversations(engine.conversations());
        setSession({ ogcId, status: 'ready', engine, error: undefined });
        link = dependencies.createRealtime(client, { onState: setConnection }, onEvent, () => {
          void engine
            .refreshConversations()
            .then(() => engine.syncAll())
            .catch(() => undefined);
        });
        realtime.current = link;
        link.connect();
        await engine.refreshConversations();
      } catch (cause) {
        if (isCancelled()) return;
        setSession({
          ogcId,
          status: 'error',
          engine: undefined,
          error: cause instanceof Error ? cause.message : 'Messaging could not start',
        });
      }
    };
    void start();

    // Back in the foreground: catch up and send anything queued while away.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active' && instance) {
        void instance.syncAll().catch(() => undefined);
      }
    });

    return () => {
      cancelled = true;
      appState.remove();
      unsubscribe?.();
      link?.disconnect();
      realtime.current = undefined;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [ogcId, client, dependencies]);

  const current = session?.ogcId === ogcId ? session : undefined;
  const engine = current?.engine;

  const setTyping = useCallback((conversationId: string, isTyping: boolean) => {
    realtime.current?.typing(conversationId, isTyping);
  }, []);

  const watchPresence = useCallback((ogcIds: OgcId[]) => {
    void realtime.current?.subscribePresence(ogcIds).then((states) => {
      setPresence((previous) => {
        const next = { ...previous };
        for (const view of states) next[view.ogcId] = view.state;
        return next;
      });
    });
  }, []);

  const value = useMemo<MessagingContextValue>(() => {
    const visible = ogcId && engine ? conversations : [];
    return {
      status: !ogcId ? 'idle' : (current?.status ?? 'starting'),
      error: current?.error,
      connection,
      engine,
      conversations: visible,
      messageRevision,
      typing,
      presence,
      unreadTotal: visible.reduce((sum, c) => sum + (c.blockedByMe ? 0 : c.unreadCount), 0),
      notificationsUnread,
      setNotificationsUnread,
      invitationsRevision,
      channelRevision,
      setTyping,
      watchPresence,
    };
  }, [
    ogcId,
    current,
    engine,
    connection,
    conversations,
    messageRevision,
    typing,
    presence,
    notificationsUnread,
    invitationsRevision,
    channelRevision,
    setTyping,
    watchPresence,
  ]);

  return <MessagingContext value={value}>{children}</MessagingContext>;
}
