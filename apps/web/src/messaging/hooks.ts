import { type LocalMessage, type TimelineEvent, previewText } from '@ogc/messaging';
import { useEffect, useState } from 'react';
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

/** A group's membership and settings events stored on this device (oldest first). */
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
  const messages = useConversationMessages(conversationId, 1);
  return messages?.at(-1);
}

export { previewText };
