import { conversationAvatar, conversationTitle } from '@ogc/messaging';
import type { ChannelView, ConversationView } from '@ogc/types';
import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { listTime } from '../../messaging/format';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import styles from './community.module.css';

/**
 * A private group (or private encrypted channel): an MLS-encrypted conversation between its
 * members. Marked with a lock and "End-to-end encrypted" so it is never confused with a
 * community channel.
 */
export function GroupCard({ conversation }: { conversation: ConversationView }) {
  const group = conversation.group;
  const id = useId();
  if (!group) return null;
  const title = conversationTitle(conversation);
  const avatar = conversationAvatar(conversation);
  const unread = conversation.unreadCount;
  return (
    <li className={styles.card}>
      <Link
        to={`/messages/${conversation.id}`}
        className={styles.cardLink}
        aria-label={`${title}${unread > 0 ? `, ${String(unread)} unread` : ''}`}
        aria-describedby={`${id}-meta`}
      >
        <span className={styles.avatarWrap}>
          <Avatar url={avatar.url} name={avatar.name} size={48} />
          <span className={[styles.kindBadge, styles.kindGroup].join(' ')} aria-hidden="true">
            <Icon name="lock" size={12} />
          </span>
        </span>
        <span className={styles.body}>
          <span className={styles.top}>
            <span className={styles.name}>{title}</span>
            {conversation.lastActivityAt ? (
              <span className={styles.time}>{listTime(conversation.lastActivityAt)}</span>
            ) : null}
          </span>
          <span className={styles.meta} id={`${id}-meta`}>
            {group.kind === 'CHANNEL' ? 'Private channel' : 'Group'} · {group.memberCount}{' '}
            {group.memberCount === 1 ? 'member' : 'members'}
            {group.myRole !== 'MEMBER' ? ` · ${group.myRole.toLowerCase()}` : ''}
          </span>
          <span className={styles.tags}>
            <span className={[styles.tag, styles.tagSecure].join(' ')}>End-to-end encrypted</span>
            {group.archived ? <span className={styles.tag}>Archived</span> : null}
          </span>
        </span>
        {unread > 0 ? (
          <span className={styles.unread} aria-hidden="true">
            {unread > 999 ? '999+' : unread}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * A community channel: an open, moderated feed for larger audiences. Marked with a megaphone,
 * its @handle and "Community channel"; channels are not end-to-end encrypted.
 * The link's accessible name is the channel name; the meta line describes it.
 */
export function ChannelCard({ channel }: { channel: ChannelView }) {
  const pending = channel.membership?.status === 'PENDING';
  const unread = channel.unreadCount;
  const id = useId();
  return (
    <li className={styles.card}>
      <Link
        to={`/channels/${channel.id}`}
        className={styles.cardLink}
        aria-label={`${channel.name}${unread > 0 ? `, ${String(unread)} unread` : ''}`}
        aria-describedby={`${id}-meta`}
      >
        <span className={styles.avatarWrap}>
          <Avatar url={channel.avatarUrl} name={channel.name} size={48} />
          <span className={[styles.kindBadge, styles.kindChannel].join(' ')} aria-hidden="true">
            <Icon name="megaphone" size={12} />
          </span>
        </span>
        <span className={styles.body}>
          <span className={styles.top}>
            <span className={styles.name}>{channel.name}</span>
            {channel.lastPostAt ? (
              <span className={styles.time}>{listTime(channel.lastPostAt)}</span>
            ) : null}
          </span>
          <span className={styles.meta} id={`${id}-meta`}>
            Community channel · @{channel.handle} · {channel.memberCount}{' '}
            {channel.memberCount === 1 ? 'member' : 'members'}
          </span>
          {channel.description ? (
            <span className={styles.description}>{channel.description}</span>
          ) : null}
          <span className={styles.tags}>
            <span className={[styles.tag, styles.tagChannel].join(' ')}>
              {channel.visibility === 'PRIVATE' ? 'Private community' : 'Public community'}
            </span>
            {pending ? <span className={styles.tag}>Request pending</span> : null}
            {channel.archived ? <span className={styles.tag}>Archived</span> : null}
          </span>
        </span>
        {unread > 0 ? (
          <span className={styles.unread} aria-hidden="true">
            {unread > 999 ? '999+' : unread}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** A responsive grid of GroupCards or ChannelCards. */
export function CardGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className={styles.grid} aria-label={label}>
      {children}
    </ul>
  );
}
