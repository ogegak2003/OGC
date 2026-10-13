import { type LocalMessage, type MessageDisplayStatus, messageStatus } from '@ogc/messaging';
import {
  type ConversationView,
  REACTION_EMOJI,
  REACTION_TYPES,
  type ReactionType,
} from '@ogc/types';
import { useState } from 'react';
import { messageTime } from '../../messaging/format';
import { previewText } from '../../messaging/hooks';
import { AttachmentView } from './AttachmentView';
import styles from './messaging.module.css';

const STATUS_LABEL: Record<MessageDisplayStatus, string> = {
  PENDING: 'Sending',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Not sent',
};

const STATUS_ICON: Record<MessageDisplayStatus, string> = {
  PENDING: '◷',
  SENT: '✓',
  DELIVERED: '✓✓',
  READ: '✓✓',
  FAILED: '!',
};

export interface MessageActions {
  reply: (message: LocalMessage) => void;
  edit: (message: LocalMessage) => void;
  forward: (message: LocalMessage) => void;
  deleteForMe: (message: LocalMessage) => void;
  deleteForEveryone: (message: LocalMessage) => void;
  react: (message: LocalMessage, reaction: ReactionType, add: boolean) => void;
  retry: (message: LocalMessage) => void;
  discard: (message: LocalMessage) => void;
}

function Placeholder({ message }: { message: LocalMessage }) {
  switch (message.state) {
    case 'deleted':
      return <p className={styles.placeholder}>This message was deleted</p>;
    case 'unavailable':
      return (
        <p className={styles.placeholder}>
          <span aria-hidden="true">🔒 </span>Sent before this device joined the conversation, so it
          can’t be decrypted here.
        </p>
      );
    case 'undecryptable':
      return <p className={styles.placeholder}>This message couldn’t be decrypted or verified.</p>;
    default:
      return null;
  }
}

/** One message. Content is rendered as plain text only — never as HTML. */
export function MessageBubble({
  message,
  conversation,
  myOgcId,
  replyTarget,
  actions,
}: {
  message: LocalMessage;
  conversation: ConversationView | undefined;
  myOgcId: string;
  replyTarget: LocalMessage | undefined | null;
  actions: MessageActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = messageStatus(message, conversation);
  const readable = message.state === 'ok' && message.payload !== null;
  const sent = message.id !== null && message.state !== 'pending' && message.state !== 'failed';
  const canAct = sent && message.state !== 'deleted';
  const grouped = new Map<ReactionType, { count: number; mine: boolean }>();
  for (const r of message.reactions) {
    const entry = grouped.get(r.reaction) ?? { count: 0, mine: false };
    grouped.set(r.reaction, { count: entry.count + 1, mine: entry.mine || r.ogcId === myOgcId });
  }

  const close = () => {
    setMenuOpen(false);
  };
  const act = (run: () => void) => () => {
    close();
    run();
  };

  return (
    <article
      id={message.id ? `m-${message.id}` : undefined}
      className={[styles.message, message.mine ? styles.mine : styles.theirs].join(' ')}
      aria-label={`${message.mine ? 'You' : 'Them'}, ${messageTime(message.createdAt)}`}
    >
      <div className={styles.bubble}>
        {message.forwarded ? <p className={styles.forwarded}>Forwarded</p> : null}
        {message.replyToId ? (
          <a className={styles.quote} href={`#m-${message.replyToId}`}>
            {replyTarget ? previewText(replyTarget) : 'Original message unavailable'}
          </a>
        ) : null}
        {readable ? (
          <>
            {message.payload?.attachments?.map((attachment) => (
              <AttachmentView key={attachment.id} descriptor={attachment} />
            ))}
            {message.payload?.text ? <p className={styles.text}>{message.payload.text}</p> : null}
          </>
        ) : (
          <Placeholder message={message} />
        )}
        <p className={styles.meta}>
          {message.editedAt ? <span className={styles.edited}>edited · </span> : null}
          <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
          {status ? (
            <span
              className={[
                styles.status,
                status === 'READ' ? styles.statusRead : '',
                status === 'FAILED' ? styles.statusFailed : '',
              ].join(' ')}
              role="img"
              aria-label={STATUS_LABEL[status]}
              title={STATUS_LABEL[status]}
            >
              {STATUS_ICON[status]}
            </span>
          ) : null}
        </p>
      </div>

      {grouped.size > 0 ? (
        <div className={styles.reactions}>
          {[...grouped.entries()].map(([reaction, { count, mine }]) => (
            <button
              key={reaction}
              type="button"
              className={[styles.reaction, mine ? styles.reactionMine : ''].join(' ')}
              aria-pressed={mine}
              aria-label={`${reaction.replace('_', ' ')} reaction, ${String(count)}${mine ? ', including yours' : ''}`}
              onClick={() => {
                actions.react(message, reaction, !mine);
              }}
            >
              {REACTION_EMOJI[reaction]} {count > 1 ? count : null}
            </button>
          ))}
        </div>
      ) : null}

      {message.state === 'failed' ? (
        <div className={styles.failedActions}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              actions.retry(message);
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              actions.discard(message);
            }}
          >
            Discard
          </button>
        </div>
      ) : null}

      {canAct ? (
        <div className={styles.menuWrap}>
          <button
            type="button"
            className={styles.menuButton}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Message actions"
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div
              className={styles.menu}
              role="menu"
              onKeyDown={(event) => {
                if (event.key === 'Escape') close();
              }}
            >
              <div className={styles.reactionPicker} role="group" aria-label="React">
                {REACTION_TYPES.map((reaction) => {
                  const mine = grouped.get(reaction)?.mine ?? false;
                  return (
                    <button
                      key={reaction}
                      type="button"
                      role="menuitem"
                      className={[styles.pick, mine ? styles.reactionMine : ''].join(' ')}
                      aria-label={`React with ${reaction.replace('_', ' ')}`}
                      onClick={act(() => {
                        actions.react(message, reaction, !mine);
                      })}
                    >
                      {REACTION_EMOJI[reaction]}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={act(() => {
                  actions.reply(message);
                })}
              >
                Reply
              </button>
              {readable && message.payload?.text ? (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={act(() => {
                    void navigator.clipboard.writeText(message.payload?.text ?? '');
                  })}
                >
                  Copy text
                </button>
              ) : null}
              {message.mine && readable && message.payload?.text ? (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={act(() => {
                    actions.edit(message);
                  })}
                >
                  Edit
                </button>
              ) : null}
              {readable ? (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={act(() => {
                    actions.forward(message);
                  })}
                >
                  Forward
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={act(() => {
                  actions.deleteForMe(message);
                })}
              >
                Delete for me
              </button>
              {message.mine ? (
                <button
                  type="button"
                  role="menuitem"
                  className={[styles.menuItem, styles.danger].join(' ')}
                  onClick={act(() => {
                    actions.deleteForEveryone(message);
                  })}
                >
                  Delete for everyone
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
