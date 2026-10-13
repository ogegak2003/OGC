import type { LocalMessage } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listTime } from '../../messaging/format';
import { previewText, useLastMessage } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import styles from './messaging.module.css';

function ConversationRow({
  conversation,
  active,
}: {
  conversation: ConversationView;
  active: boolean;
}) {
  const { typing, presence } = useMessaging();
  const last = useLastMessage(conversation.id);
  const online = presence[conversation.peer.ogcId] === 'ONLINE';
  const unread = conversation.blockedByMe ? 0 : conversation.unreadCount;
  return (
    <li>
      <Link
        to={`/messages/${conversation.id}`}
        className={[styles.row, active ? styles.rowActive : ''].join(' ')}
        aria-current={active ? 'page' : undefined}
      >
        <span className={styles.avatarWrap}>
          <Avatar
            url={conversation.peer.avatarUrl}
            name={conversation.peer.displayName}
            size={44}
          />
          {online ? <span className={styles.onlineDot} aria-label="Online" role="img" /> : null}
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTop}>
            <span className={styles.rowName}>{conversation.peer.displayName}</span>
            <span className={styles.rowTime}>
              {listTime(last?.createdAt ?? conversation.lastActivityAt)}
            </span>
          </span>
          <span className={styles.rowBottom}>
            <span className={typing[conversation.id] ? styles.rowTyping : styles.rowPreview}>
              {typing[conversation.id]
                ? 'typing…'
                : conversation.blockedByMe
                  ? 'Blocked'
                  : previewText(last)}
            </span>
            {unread > 0 ? (
              <span className={styles.unread} aria-label={`${String(unread)} unread`}>
                {unread > 999 ? '999+' : unread}
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Sidebar: conversations by recent activity, with local (on-device) search. */
export function ConversationList({
  activeId,
  onNewConversation,
}: {
  activeId: string | undefined;
  onNewConversation: () => void;
}) {
  const { conversations, engine, status } = useMessaging();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocalMessage[]>([]);
  const trimmed = query.trim();

  useEffect(() => {
    if (!engine || trimmed.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void engine.search(trimmed, 30).then((found) => {
        if (active) setResults(found);
      });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [engine, trimmed]);

  const visibleResults = trimmed.length >= 2 ? results : [];
  const lowered = trimmed.toLocaleLowerCase();
  const shown = lowered
    ? conversations.filter(
        (c) =>
          c.peer.displayName.toLocaleLowerCase().includes(lowered) ||
          c.peer.ogcId.toLowerCase().includes(lowered),
      )
    : conversations;
  const nameOf = (conversationId: string) =>
    conversations.find((c) => c.id === conversationId)?.peer.displayName ?? 'Conversation';

  return (
    <section className={styles.sidebar} aria-label="Conversations">
      <div className={styles.sidebarHeader}>
        <h2 className={styles.sidebarTitle}>Messages</h2>
        <button type="button" className={styles.newButton} onClick={onNewConversation}>
          New
        </button>
      </div>
      <div className={styles.searchWrap}>
        <input
          type="search"
          className={styles.search}
          placeholder="Search"
          aria-label="Search conversations and messages on this device"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {status === 'starting' && conversations.length === 0 ? (
        <p className={styles.sidebarNote} role="status">
          Setting up secure messaging…
        </p>
      ) : null}
      {status === 'ready' && conversations.length === 0 && !trimmed ? (
        <div className={styles.emptyList}>
          <p className={styles.emptyTitle}>No conversations yet</p>
          <p className={styles.sidebarNote}>
            Start an end-to-end encrypted conversation with one of your contacts.
          </p>
          <button type="button" className={styles.primaryLink} onClick={onNewConversation}>
            Start a conversation
          </button>
        </div>
      ) : null}
      <ul className={styles.rows}>
        {shown.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === activeId}
          />
        ))}
      </ul>
      {trimmed.length >= 2 ? (
        <div className={styles.searchResults}>
          <h3 className={styles.sectionLabel}>Messages on this device</h3>
          {visibleResults.length === 0 ? (
            <p className={styles.sidebarNote}>No matching messages</p>
          ) : (
            <ul className={styles.rows}>
              {visibleResults.map((message) => (
                <li key={message.clientMessageId}>
                  <Link
                    to={`/messages/${message.conversationId}#${message.id ?? ''}`}
                    className={styles.resultRow}
                  >
                    <span className={styles.rowName}>{nameOf(message.conversationId)}</span>
                    <span className={styles.rowPreview}>
                      {message.payload?.text ?? previewText(message)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.sidebarNote}>
            Search runs on this device only — your messages are never searchable on OGC’s servers.
          </p>
        </div>
      ) : null}
    </section>
  );
}
