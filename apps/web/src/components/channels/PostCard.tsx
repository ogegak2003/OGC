import {
  REACTION_EMOJI,
  REACTION_TYPES,
  type ChannelPostView,
  type ReactionType,
} from '@ogc/types';
import { useState } from 'react';
import { Avatar } from '../Avatar';
import styles from '../messaging/messaging.module.css';
import { Icon } from '../Icon';

export interface PostActions {
  react: (post: ChannelPostView, reaction: ReactionType, add: boolean) => void;
  openThread?: (post: ChannelPostView) => void;
  edit?: (post: ChannelPostView) => void;
  remove?: (post: ChannelPostView) => void;
  moderate?: (post: ChannelPostView, removed: boolean) => void;
  pin?: (post: ChannelPostView, pinned: boolean) => void;
  report?: (post: ChannelPostView) => void;
}

/**
 * A community channel post. Text is rendered as plain text only — never as
 * HTML. Removed posts show a placeholder (moderators see the original for review).
 */
export function PostCard({
  post,
  mine,
  canModerate,
  canReact,
  actions,
}: {
  post: ChannelPostView;
  mine: boolean;
  canModerate: boolean;
  canReact: boolean;
  actions: PostActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hidden = post.deletedAt !== null || post.removed;
  const close = () => {
    setMenuOpen(false);
  };
  return (
    <article
      className={[styles.post, post.announcement ? styles.announcement : ''].join(' ')}
      aria-label={`Post by ${post.author?.displayName ?? 'a former member'}`}
    >
      <header className={styles.postHeader}>
        <Avatar
          url={post.author?.avatarUrl ?? null}
          name={post.author?.displayName ?? '?'}
          size={32}
        />
        <span className={styles.pickName}>{post.author?.displayName ?? 'Former member'}</span>
        {post.announcement ? <span className={styles.kindTag}>Announcement</span> : null}
        {post.pinnedAt ? <span className={styles.kindTag}>Pinned</span> : null}
        <time className={styles.rowTime} dateTime={post.createdAt}>
          {new Date(post.createdAt).toLocaleString()}
        </time>
      </header>
      {post.deletedAt ? <p className={styles.placeholder}>This post was deleted</p> : null}
      {post.removed && !post.deletedAt ? (
        <p className={styles.placeholder}>Removed by a moderator</p>
      ) : null}
      {post.removedBody ? (
        <p className={styles.disclosure} aria-label="Removed post, visible to moderators">
          {post.removedBody}
        </p>
      ) : null}
      {!hidden && post.body ? <p className={styles.text}>{post.body}</p> : null}
      {!hidden && post.attachments.length > 0 ? (
        <div className={styles.postMedia}>
          {post.attachments.map((a) =>
            a.mime === 'image/webp' ? (
              <img
                key={a.id}
                src={a.url}
                alt={a.name}
                className={styles.postImage}
                loading="lazy"
              />
            ) : (
              <a key={a.id} href={a.url} className={styles.fileLink} download>
                {a.name}
              </a>
            ),
          )}
        </div>
      ) : null}
      {post.editedAt && !hidden ? <p className={styles.edited}>edited</p> : null}
      <footer className={styles.postFooter}>
        {post.reactions.map((r) => (
          <button
            key={r.reaction}
            type="button"
            className={[styles.reaction, r.mine ? styles.reactionMine : ''].join(' ')}
            aria-pressed={r.mine}
            disabled={!canReact}
            aria-label={`${r.reaction.replace('_', ' ')} reaction, ${String(r.count)}`}
            onClick={() => {
              actions.react(post, r.reaction, !r.mine);
            }}
          >
            {REACTION_EMOJI[r.reaction]} {r.count}
          </button>
        ))}
        {actions.openThread && !post.replyToId ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              actions.openThread?.(post);
            }}
          >
            {post.replyCount === 1
              ? '1 reply'
              : post.replyCount > 0
                ? `${String(post.replyCount)} replies`
                : 'Reply'}
          </button>
        ) : null}
        {!hidden || canModerate ? (
          <span className={styles.menuWrap}>
            <button
              type="button"
              className={styles.menuButton}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Post actions"
              onClick={() => {
                setMenuOpen((open) => !open);
              }}
            >
              <Icon name="moreHorizontal" size={18} />
            </button>
            {menuOpen ? (
              <div className={styles.menu} role="menu">
                {canReact && !hidden ? (
                  <div className={styles.reactionPicker} role="group" aria-label="React">
                    {REACTION_TYPES.map((reaction) => {
                      const mineReaction = post.reactions.some(
                        (r) => r.reaction === reaction && r.mine,
                      );
                      return (
                        <button
                          key={reaction}
                          type="button"
                          role="menuitem"
                          className={styles.pick}
                          aria-label={`React with ${reaction.replace('_', ' ')}`}
                          onClick={() => {
                            close();
                            actions.react(post, reaction, !mineReaction);
                          }}
                        >
                          {REACTION_EMOJI[reaction]}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {mine && !hidden && actions.edit ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      close();
                      actions.edit?.(post);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
                {mine && !post.deletedAt && actions.remove ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={[styles.menuItem, styles.danger].join(' ')}
                    onClick={() => {
                      close();
                      actions.remove?.(post);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
                {canModerate &&
                !post.deletedAt &&
                !post.replyToId &&
                actions.pin &&
                !post.removed ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      close();
                      actions.pin?.(post, post.pinnedAt === null);
                    }}
                  >
                    {post.pinnedAt ? 'Unpin' : 'Pin'}
                  </button>
                ) : null}
                {canModerate && !mine && !post.deletedAt && actions.moderate ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={[styles.menuItem, post.removed ? '' : styles.danger].join(' ')}
                    onClick={() => {
                      close();
                      actions.moderate?.(post, !post.removed);
                    }}
                  >
                    {post.removed ? 'Restore' : 'Remove'}
                  </button>
                ) : null}
                {!mine && !hidden && actions.report ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      close();
                      actions.report?.(post);
                    }}
                  >
                    Report
                  </button>
                ) : null}
              </div>
            ) : null}
          </span>
        ) : null}
      </footer>
    </article>
  );
}
