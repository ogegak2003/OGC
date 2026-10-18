import {
  type CallState,
  type GroupSecurityEvent,
  IDLE_CALL_STATE,
  type LocalMessage,
  type TimelineEvent,
  pendingGroupWarnings,
} from '@ogc/messaging';
import type { CallView } from '@ogc/types';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useMessaging } from './messaging-context';

/** The locally stored (decrypted) messages of a conversation, kept in sync with the engine. */
export function useConversationMessages(conversationId: string | undefined, limit = 300) {
  const { engine, messageRevision } = useMessaging();
  const revision = conversationId ? (messageRevision[conversationId] ?? 0) : 0;
  const [messages, setMessages] = useState<LocalMessage[] | undefined>(undefined);

  useEffect(() => {
    if (!engine || !conversationId) return;
    let active = true;
    void engine.messages(conversationId, limit).then((list) => {
      if (active) setMessages(list);
    });
    return () => {
      active = false;
    };
  }, [engine, conversationId, revision, limit]);

  return messages;
}

/**
 * Whether this conversation waits for another device to join before encryption can resume
 * (decided by the engine; re-read whenever the conversation changes).
 */
export function useAwaitingAnotherDevice(conversationId: string): boolean {
  // Synchronous engine state: a `recovery` event bumps `messageRevision`, re-rendering this.
  const { engine } = useMessaging();
  return engine?.awaitingAnotherDevice(conversationId) ?? false;
}

/**
 * A group's security changes that still need the person's attention, computed on this device
 * from its own MLS state (re-read whenever the conversation changes).
 */
export function useGroupSecurityWarnings(
  conversationId: string,
  enabled: boolean,
): GroupSecurityEvent[] {
  const { engine, messageRevision } = useMessaging();
  const revision = messageRevision[conversationId] ?? 0;
  const [events, setEvents] = useState<GroupSecurityEvent[]>([]);

  useEffect(() => {
    if (!engine || !enabled) return;
    let active = true;
    engine.groupSecurity(conversationId).then(
      (list) => {
        if (active) setEvents(pendingGroupWarnings(list));
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [engine, conversationId, revision, enabled]);

  return enabled ? events : [];
}

/** A group's membership and settings events stored on this device. */
export function useTimeline(conversationId: string): TimelineEvent[] {
  const { engine, messageRevision } = useMessaging();
  const revision = messageRevision[conversationId] ?? 0;
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  useEffect(() => {
    if (!engine) return;
    let active = true;
    void engine.timeline(conversationId).then((list) => {
      if (active) setEvents(list);
    });
    return () => {
      active = false;
    };
  }, [engine, conversationId, revision]);
  return events;
}

export function useLastMessage(conversationId: string): LocalMessage | undefined {
  return useConversationMessages(conversationId, 1)?.at(-1);
}

/** The current call on this device (idle when calls are not available yet). */
export function useCall(): CallState {
  const { calls } = useMessaging();
  return useSyncExternalStore(
    useCallback((listener: () => void) => calls?.subscribe(listener) ?? (() => undefined), [calls]),
    () => calls?.current ?? IDLE_CALL_STATE,
  );
}

/** A conversation's calls (oldest first), refreshed whenever a call ends. */
export function useCallHistory(conversationId: string, enabled: boolean): CallView[] {
  const { client } = useAuth();
  const { callsRevision } = useMessaging();
  const [calls, setCalls] = useState<CallView[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    client.calls(conversationId).then(
      (page) => {
        if (active) setCalls([...page.items].reverse());
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [client, conversationId, enabled, callsRevision]);
  return enabled ? calls : [];
}

/** The account's recent calls (newest first), refreshed whenever a call ends. */
export function useRecentCalls(): { calls: CallView[] | undefined; failed: boolean } {
  const { client } = useAuth();
  const { callsRevision, status } = useMessaging();
  const [calls, setCalls] = useState<CallView[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (status !== 'ready') return;
    let active = true;
    client.calls().then(
      (page) => {
        if (!active) return;
        setCalls(page.items);
        setFailed(false);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, callsRevision, status]);
  return { calls, failed };
}
