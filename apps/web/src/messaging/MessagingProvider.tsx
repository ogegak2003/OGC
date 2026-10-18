import { CallEngine, type ConnectionState } from '@ogc/messaging';
import type { ConversationView, OgcId, PresenceState, ServerToClientEvents } from '@ogc/types';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/auth-context';
import { renewSession } from '../lib/api';
import { notificationsApi } from '../lib/community-api';
import { browserDependencies } from './browser-dependencies';
import { INSECURE_CONTEXT_ERROR, canEncryptHere } from './secure-context';
import {
  type MessagingContextValue,
  MessagingContext,
  type MessagingDependencies,
  type MessagingEngine,
  type RealtimeLink,
} from './messaging-context';

/** The other person stops "typing" if no refresh arrives within this time. */
const TYPING_DISPLAY_MS = 8_000;

interface Session {
  ogcId: string;
  status: 'ready' | 'error';
  engine: MessagingEngine | undefined;
  error: string | undefined;
}

/**
 * Runs the end-to-end encrypted messaging engine for the signed-in account:
 * device keys, realtime connection, sync on (re)connect, typing and presence.
 * Signing out erases this browser's local messaging data for the account.
 */
export function MessagingProvider({
  children,
  dependencies = browserDependencies,
}: {
  children: ReactNode;
  dependencies?: MessagingDependencies;
}) {
  const { state } = useAuth();
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
  const [attempt, setAttempt] = useState(0);
  const [calls, setCalls] = useState<CallEngine>();
  const [callsRevision, setCallsRevision] = useState(0);
  const realtime = useRef<RealtimeLink | undefined>(undefined);
  const lastAccount = useRef<string | undefined>(undefined);

  // Sign-out: forget everything this browser stored for the previous account.
  useEffect(() => {
    if (state.status === 'signed-out' && lastAccount.current) {
      const previous = lastAccount.current;
      lastAccount.current = undefined;
      void dependencies.destroyLocalData(previous);
    }
    if (ogcId) lastAccount.current = ogcId;
  }, [state.status, ogcId, dependencies]);

  useEffect(() => {
    if (!ogcId) return;
    let cancelled = false;
    // A function, so TypeScript re-reads the flag after each await.
    const isCancelled = () => cancelled;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let unsubscribe: (() => void) | undefined;
    let link: RealtimeLink | undefined;
    let instance: MessagingEngine | undefined;
    let callEngine: CallEngine | undefined;
    let unsubscribeCalls: (() => void) | undefined;

    const onEvent = <E extends keyof ServerToClientEvents>(
      event: E,
      payload: Parameters<ServerToClientEvents[E]>[0],
    ): void => {
      if (event.startsWith('call.')) {
        callEngine?.handleEvent(event, payload);
        return;
      }
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
        // A new message ends the sender's typing indicator.
        const { message } = payload as Parameters<ServerToClientEvents['message.created']>[0];
        setTypingState((current) => ({ ...current, [message.conversationId]: false }));
      }
      instance?.handleRealtime(event, payload);
    };

    const start = async (): Promise<void> => {
      try {
        // Explain an insecure page instead of failing on a missing Web Crypto API.
        if (!canEncryptHere()) throw new Error(INSECURE_CONTEXT_ERROR);
        const engine = await dependencies.createEngine(ogcId);
        instance = engine;
        // Unmounted (or replaced, e.g. React Strict Mode) while the engine was being created:
        // this run's cleanup has already happened, so shut this engine down here.
        if (isCancelled()) {
          engine.dispose();
          return;
        }
        unsubscribe = engine.subscribe((event) => {
          if (event.type === 'conversations') setConversations(engine.conversations());
          // A group security change re-reads the conversation like new messages do.
          if (event.type === 'messages' || event.type === 'security' || event.type === 'recovery') {
            setMessageRevision((current) => ({
              ...current,
              [event.conversationId]: (current[event.conversationId] ?? 0) + 1,
            }));
          }
          if (event.type === 'notification') setNotificationsUnread((n) => n + 1);
          if (event.type === 'invitations') setInvitationsRevision((n) => n + 1);
          if (event.type === 'channel') {
            setChannelRevision((current) => ({
              ...current,
              [event.channelId]: (current[event.channelId] ?? 0) + 1,
            }));
          }
        });
        await engine.start();
        if (isCancelled()) return;
        setConversations(engine.conversations());
        setSession({ ogcId, status: 'ready', engine, error: undefined });
        link = dependencies.createRealtime(
          {
            onState: setConnection,
            onUnauthorized: async () => {
              await renewSession();
            },
          },
          onEvent,
          () => {
            // A call shown here may have ended while offline, or one may be ringing now.
            void callEngine?.resync();
            // Every (re)connection: catch up on anything missed, then send queued messages.
            void engine
              .refreshConversations()
              .then(() => engine.syncAll())
              .catch(() => undefined);
          },
        );
        realtime.current = link;
        callEngine = new CallEngine(link, dependencies.createCallMedia?.());
        let previousPhase = callEngine.current.phase;
        unsubscribeCalls = callEngine.subscribe((state) => {
          if (state.phase === 'ended' && previousPhase !== 'ended') {
            setCallsRevision((n) => n + 1);
          }
          previousPhase = state.phase;
        });
        setCalls(callEngine);
        link.connect();
        await engine.refreshConversations();
        const inbox = await notificationsApi.list().catch(() => undefined);
        if (inbox && !isCancelled()) setNotificationsUnread(inbox.unread);
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

    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeCalls?.();
      // Hangs up and releases the camera and microphone (sign-out, account change).
      callEngine?.dispose();
      setCalls(undefined);
      link?.disconnect();
      // Stops its retry timers and any further requests; queued messages stay in the sealed
      // outbox for the next engine (each run owns the engine it created).
      instance?.dispose();
      realtime.current = undefined;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [ogcId, dependencies, attempt]);

  const current = session?.ogcId === ogcId ? session : undefined;
  const engine = current?.engine;

  // Retry queued messages when the browser comes back online.
  useEffect(() => {
    if (!engine) return;
    const onOnline = () => {
      void engine.flushOutbox().catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
    };
  }, [engine]);

  // Back in the foreground: confirm the call on screen still exists (or show one ringing).
  useEffect(() => {
    if (!calls) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void calls.resync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [calls]);

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

  // Start again after a failed start (e.g. the browser was offline).
  const retry = useCallback(() => {
    setSession(undefined);
    setAttempt((n) => n + 1);
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
      calls: ogcId ? calls : undefined,
      callsRevision,
      retry,
    };
  }, [
    calls,
    callsRevision,
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
    retry,
  ]);

  return <MessagingContext value={value}>{children}</MessagingContext>;
}
