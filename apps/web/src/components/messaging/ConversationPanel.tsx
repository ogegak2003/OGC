import type { LocalMessage } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { attachmentKind, dayLabel, safeFileName, safeMime, sameDay } from '../../messaging/format';
import { useConversationMessages } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { Alert } from '../ui';
import { type ComposerSubmit, Composer } from './Composer';
import { ForwardDialog, SafetyNumberDialog } from './Dialogs';
import { type MessageActions, MessageBubble } from './MessageBubble';
import styles from './messaging.module.css';

function errorMessage(error: unknown): string {
  const { code, status } = error as { code?: string; status?: number };
  if (code === 'BLOCKED') return 'Unblock this person to send messages.';
  if (status === 429) return 'You’re sending messages too quickly. They’ll be sent shortly.';
  if (status === 0) return 'You’re offline. Your message will be sent when you reconnect.';
  if (status === 413) return 'That file is too large.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function ConversationPanel({ conversation }: { conversation: ConversationView }) {
  const { engine, typing, presence, connection, setTyping, watchPresence } = useMessaging();
  const messages = useConversationMessages(conversation.id);
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  const [forwarding, setForwarding] = useState<LocalMessage | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<LocalMessage | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const peer = conversation.peer;
  const blocked = conversation.blockedByMe;

  useEffect(() => {
    watchPresence([peer.ogcId]);
  }, [peer.ogcId, watchPresence]);

  // Sync when opened, then keep the read receipt current while the conversation is visible.
  useEffect(() => {
    if (!engine) return;
    void engine.syncConversation(conversation.id).catch(() => undefined);
  }, [engine, conversation.id]);

  const newestSeq = messages?.reduce((max, m) => Math.max(max, m.seq ?? 0), 0) ?? 0;
  useEffect(() => {
    if (!engine || newestSeq === 0 || document.visibilityState !== 'visible') return;
    void engine.markRead(conversation.id).catch(() => undefined);
  }, [engine, conversation.id, newestSeq]);

  const count = messages?.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count, conversation.id]);

  const byId = useMemo(
    () => new Map((messages ?? []).filter((m) => m.id).map((m) => [m.id, m])),
    [messages],
  );

  const run = (task: Promise<unknown>) => {
    setError(undefined);
    task.catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
  };

  const actions: MessageActions = {
    reply: (message) => {
      setEditing(null);
      setReplyTo(message);
    },
    edit: (message) => {
      setReplyTo(null);
      setEditing(message);
    },
    forward: setForwarding,
    deleteForMe: (message) => {
      if (engine && message.id) run(engine.deleteForMe(conversation.id, message.id));
    },
    deleteForEveryone: setConfirmDelete,
    react: (message, reaction, add) => {
      if (engine && message.id) run(engine.react(conversation.id, message.id, reaction, add));
    },
    retry: (message) => {
      if (!engine || !message.payload) return;
      run(
        engine.discardFailed(conversation.id, message.clientMessageId).then(() =>
          engine.send(conversation.id, {
            ...(message.payload?.text ? { text: message.payload.text } : {}),
            ...(message.payload?.attachments ? { attachments: message.payload.attachments } : {}),
            ...(message.replyToId ? { replyToId: message.replyToId } : {}),
          }),
        ),
      );
    },
    discard: (message) => {
      if (engine) run(engine.discardFailed(conversation.id, message.clientMessageId));
    },
  };

  const submit = async ({ text, files, voice }: ComposerSubmit) => {
    if (!engine) return;
    setError(undefined);
    try {
      if (editing?.id) {
        await engine.edit(conversation.id, editing.id, text);
        setEditing(null);
        return;
      }
      const attachments = [];
      for (const file of files) {
        attachments.push(
          await engine.uploadAttachment(conversation.id, {
            kind: attachmentKind(file.type),
            name: safeFileName(file.name),
            mime: safeMime(file.type || 'application/octet-stream'),
            bytes: new Uint8Array(await file.arrayBuffer()),
          }),
        );
      }
      if (voice) {
        attachments.push(
          await engine.uploadAttachment(conversation.id, {
            kind: 'VOICE',
            name: 'Voice message',
            mime: voice.mime,
            bytes: voice.bytes,
            durationMs: Math.max(1, voice.durationMs),
          }),
        );
      }
      const reply = replyTo?.id;
      setReplyTo(null);
      await engine.send(conversation.id, {
        ...(text ? { text } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(reply ? { replyToId: reply } : {}),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const status = typing[conversation.id]
    ? 'typing…'
    : presence[peer.ogcId] === 'ONLINE'
      ? 'Online'
      : 'End-to-end encrypted';

  return (
    <section className={styles.panel} aria-label={`Conversation with ${peer.displayName}`}>
      <header className={styles.panelHeader}>
        <Link to="/messages" className={styles.back} aria-label="Back to conversations">
          ‹
        </Link>
        <Link to={`/id/${peer.ogcId}`} className={styles.peer}>
          <Avatar url={peer.avatarUrl} name={peer.displayName} size={40} />
          <span className={styles.peerText}>
            <span className={styles.peerName}>{peer.displayName}</span>
            <span
              className={typing[conversation.id] ? styles.rowTyping : styles.peerStatus}
              aria-live="polite"
            >
              {status}
            </span>
          </span>
        </Link>
        <button
          type="button"
          className={styles.smallButton}
          onClick={() => {
            setVerifying(true);
          }}
        >
          Verify
        </button>
      </header>

      {connection === 'offline' ? (
        <p className={styles.banner} role="status">
          Offline — reconnecting. Messages you send are queued on this device.
        </p>
      ) : null}
      {blocked ? (
        <div className={styles.banner} role="status">
          You blocked {peer.displayName}. You won’t receive their messages.{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              run(api.unblock(peer.ogcId).then(() => engine?.refreshConversations()));
            }}
          >
            Unblock
          </button>
        </div>
      ) : null}

      <div
        className={styles.log}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages === undefined ? <p className={styles.sidebarNote}>Loading messages…</p> : null}
        {messages?.length === 0 ? (
          <div className={styles.emptyConversation}>
            <p className={styles.emptyTitle}>Say hello to {peer.displayName}</p>
            <p className={styles.sidebarNote}>
              Messages are end-to-end encrypted. Only your and {peer.displayName}’s devices can read
              them — not OGC.
            </p>
          </div>
        ) : null}
        {messages?.map((message, index) => {
          const previous = messages[index - 1];
          const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
          return (
            <Fragment key={message.clientMessageId}>
              {newDay ? (
                <p className={styles.day} role="separator">
                  {dayLabel(message.createdAt)}
                </p>
              ) : null}
              <MessageBubble
                message={message}
                conversation={conversation}
                myOgcId={engine?.ogcId ?? ''}
                replyTarget={message.replyToId ? (byId.get(message.replyToId) ?? null) : undefined}
                actions={actions}
              />
            </Fragment>
          );
        })}
        <div ref={bottom} />
      </div>

      {error ? <Alert>{error}</Alert> : null}
      <Composer
        key={editing?.clientMessageId ?? 'compose'}
        disabled={blocked || !engine}
        replyTo={replyTo}
        editing={editing}
        onCancelContext={() => {
          setReplyTo(null);
          setEditing(null);
        }}
        onSubmit={submit}
        onTyping={(isTyping) => {
          setTyping(conversation.id, isTyping);
        }}
        onError={setError}
      />

      {forwarding ? (
        <ForwardDialog
          currentId={conversation.id}
          onClose={() => {
            setForwarding(null);
          }}
          onForward={async (target) => {
            if (engine && forwarding.id)
              await engine.forward(conversation.id, forwarding.id, target.id);
          }}
        />
      ) : null}
      {verifying ? (
        <SafetyNumberDialog
          conversation={conversation}
          onClose={() => {
            setVerifying(false);
          }}
        />
      ) : null}
      {confirmDelete ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Delete for everyone?">
          <p>
            Delete this message for everyone? It will be removed from OGC and from both people’s
            devices. Copies someone already saved or screenshotted can’t be recalled.
          </p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setConfirmDelete(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={[styles.smallButton, styles.danger].join(' ')}
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (engine && target.id) run(engine.deleteForEveryone(conversation.id, target.id));
              }}
            >
              Delete for everyone
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
