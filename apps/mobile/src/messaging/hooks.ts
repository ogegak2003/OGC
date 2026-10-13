import type { LocalMessage } from '@ogc/messaging';
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

export function useLastMessage(conversationId: string): LocalMessage | undefined {
  return useConversationMessages(conversationId, 1)?.at(-1);
}
