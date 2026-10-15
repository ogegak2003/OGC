import { type LocalMessage, conversationAvatar, conversationTitle } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listTime } from '../../messaging/format';
import { previewText, useLastMessage } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import styles from './messaging.module.css';

/**
 * One conversation in a list. The preview is the latest message as decrypted on this
 * device — or an honest placeholder when this device cannot read it.
 */
export function ConversationRow({
  conversation,
  active,
}: {
  conversation: ConversationView;
  active: boolean;
}) {
  const { typing, presence } = useMessaging();
  const last = useLastMessage(conversation.id);
  const online = conversation.peer ? presence[conversation.peer.ogcId] === 'ONLINE' : false;
  const unread = conversation.blockedByMe ? 0 : conversation.unreadCount;
  const avatar = conversationAvatar(conversation);
  const group = conversation.group;
  return (
    <li>
      <Link
        to={`/messages/${conversation.id}`}
        className={[styles.row, active ? styles.rowActive : ''].join(' ')}
        aria-current={active ? 'page' : undefined}
      >
        <span className={styles.avatarWrap}>
          <Avatar url={avatar.url} name={avatar.name} size={46} />
          {group ? (
            <span className={styles.kindBadge} aria-hidden="true">
              <Icon name={group.kind === 'CHANNEL' ? 'megaphone' : 'community'} size={11} />
            </span>
          ) : online ? (
            <span className={styles.onlineDot} aria-label="Online" role="img" />
          ) : null}
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTop}>
            <span className={styles.rowName}>
              {conversationTitle(conversation)}
              {group ? (
                <span className={styles.kindTag}>
                  {group.kind === 'CHANNEL' ? 'Channel' : 'Group'}
                </span>
              ) : null}
            </span>
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
                  : group?.archived
                    ? 'Archived'
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
  onNewGroup,
}: {
  activeId: string | undefined;
  onNewConversation: () => void;
  onNewGroup: () => void;
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
          conversationTitle(c).toLocaleLowerCase().includes(lowered) ||
          (c.peer?.ogcId.toLowerCase().includes(lowered) ?? false),
      )
    : conversations;
  const nameOf = (conversationId: string) => {
    const found = conversations.find((c) => c.id === conversationId);
    return found ? conversationTitle(found) : 'Conversation';
  };

  return (
    <section className={styles.sidebar} aria-label="Conversations">
      <div className={styles.sidebarHeader}>
        <h2 className={styles.sidebarTitle}>Chats</h2>
        <span className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onNewGroup}
            aria-label="New group"
            title="New group"
          >
            <Icon name="community" />
          </button>
          <button
            type="button"
            className={styles.newButton}
            onClick={onNewConversation}
            aria-label="New conversation"
            title="New conversation"
          >
            <Icon name="edit" size={18} />
            <span>New</span>
          </button>
        </span>
      </div>
      <Link to="/invitations" className={styles.invitationsLink}>
        <Icon name="inbox" size={16} />
        Group invitations
      </Link>
      <div className={styles.searchWrap}>
        <Icon name="search" size={18} className={styles.searchIcon} />
        <input
          type="search"
          className={styles.search}
          placeholder="Search chats and messages"
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
