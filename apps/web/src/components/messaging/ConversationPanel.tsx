import {
  type LocalMessage,
  type TimelineEvent,
  conversationAvatar,
  conversationTitle,
  describeEvent,
  mentionsIn,
} from '@ogc/messaging';
import type { ConversationView, GroupMemberView } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { groupsApi } from '../../lib/community-api';
import { attachmentKind, dayLabel, safeFileName, safeMime, sameDay } from '../../messaging/format';
import { useConversationMessages, useTimeline } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { Alert, Spinner } from '../ui';
import { type ComposerSubmit, Composer } from './Composer';
import { ForwardDialog, ReportMessageDialog, SafetyNumberDialog } from './Dialogs';
import { type MessageActions, MessageBubble } from './MessageBubble';
import styles from './messaging.module.css';

const GroupInfoPanel = lazy(() =>
  import('../groups/GroupInfoPanel').then((m) => ({ default: m.GroupInfoPanel })),
);

function errorMessage(error: unknown): string {
  const { code, status } = error as { code?: string; status?: number };
  if (code === 'BLOCKED') return 'Unblock this person to send messages.';
  if (code === 'ARCHIVED') return 'This group is archived and read-only.';
  if (status === 429) return 'You’re sending messages too quickly. They’ll be sent shortly.';
  if (status === 0) return 'You’re offline. Your message will be sent when you reconnect.';
  if (status === 413) return 'That file is too large.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

type TimelineItem =
  | { kind: 'message'; at: string; message: LocalMessage }
  | { kind: 'event'; at: string; event: TimelineEvent };

export function ConversationPanel({ conversation }: { conversation: ConversationView }) {
  const { engine, typing, presence, connection, setTyping, watchPresence } = useMessaging();
  const messages = useConversationMessages(conversation.id);
  const events = useTimeline(conversation.id);
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  const [forwarding, setForwarding] = useState<LocalMessage | null>(null);
  const [reporting, setReporting] = useState<LocalMessage | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<LocalMessage | null>(null);
  const [members, setMembers] = useState<GroupMemberView[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const peer = conversation.peer;
  const group = conversation.group;
  const blocked = conversation.blockedByMe;
  const title = conversationTitle(conversation);
  const avatar = conversationAvatar(conversation);
  const myOgcId = engine?.ogcId ?? '';

  useEffect(() => {
    if (peer) watchPresence([peer.ogcId]);
  }, [peer, watchPresence]);

  // Groups: the member directory names senders and timeline events (refreshed on changes).
  useEffect(() => {
    if (!group) return;
    const controller = new AbortController();
    groupsApi.members(conversation.id, controller.signal).then(setMembers, () => undefined);
    return () => {
      controller.abort();
    };
  }, [group, conversation.id, conversation.version]);

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

  const count = (messages?.length ?? 0) + events.length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count, conversation.id]);

  const byId = useMemo(
    () => new Map((messages ?? []).filter((m) => m.id).map((m) => [m.id, m])),
    [messages],
  );
  const names = useMemo(
    () => new Map(members.map((m) => [m.profile.ogcId as string, m.profile.displayName])),
    [members],
  );
  const nameOf = (ogcId: string | null): string => {
    if (!ogcId) return 'Someone';
    if (ogcId === myOgcId) return 'You';
    const name = names.get(ogcId);
    // Members without a display name (or former members) are shown by OGC ID.
    if (name !== undefined && name !== '') return name;
    return formatOgcIdForDisplay(ogcId as never);
  };

  const items = useMemo<TimelineItem[]>(() => {
    const list: TimelineItem[] = [
      ...(messages ?? []).map((message) => ({
        kind: 'message' as const,
        at: message.createdAt,
        message,
      })),
      ...events.map((event) => ({ kind: 'event' as const, at: event.createdAt, event })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [messages, events]);

  const run = (task: Promise<unknown>) => {
    setError(undefined);
    task.catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
  };

  const moderator = group !== null && group.myRole !== 'MEMBER';
  const writable = group ? group.canPost : !blocked;

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
    report: setReporting,
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
      // Mentions are found here, on the device; only the mentioned OGC IDs go to the server.
      const mentions = group
        ? mentionsIn(
            text,
            members
              .filter((m) => m.profile.ogcId !== myOgcId)
              .map((m) => ({ ogcId: m.profile.ogcId, displayName: m.profile.displayName })),
          )
        : [];
      await engine.send(conversation.id, {
        ...(text ? { text } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(reply ? { replyToId: reply } : {}),
        ...(mentions.length ? { mentions } : {}),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const status = typing[conversation.id]
    ? 'typing…'
    : group
      ? `${String(group.memberCount)} ${group.memberCount === 1 ? 'member' : 'members'} · End-to-end encrypted`
      : peer && presence[peer.ogcId] === 'ONLINE'
        ? 'Online'
        : 'End-to-end encrypted';

  const headerInner = (
    <>
      <Avatar url={avatar.url} name={avatar.name} size={40} />
      <span className={styles.peerText}>
        <span className={styles.peerName}>{title}</span>
        <span
          className={typing[conversation.id] ? styles.rowTyping : styles.peerStatus}
          aria-live="polite"
        >
          {status}
        </span>
      </span>
    </>
  );

  return (
    <section
      className={styles.panel}
      aria-label={
        group
          ? `${group.kind === 'CHANNEL' ? 'Channel' : 'Group'}: ${title}`
          : `Conversation with ${title}`
      }
    >
      <header className={styles.panelHeader}>
        <Link to="/messages" className={styles.back} aria-label="Back to conversations">
          ‹
        </Link>
        {peer ? (
          <Link to={`/id/${peer.ogcId}`} className={styles.peer}>
            {headerInner}
          </Link>
        ) : (
          <button
            type="button"
            className={[styles.peer, styles.peerButton].join(' ')}
            onClick={() => {
              setShowInfo(true);
            }}
          >
            {headerInner}
          </button>
        )}
        {group ? (
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => {
              setShowInfo(true);
            }}
          >
            Info
          </button>
        ) : (
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => {
              setVerifying(true);
            }}
          >
            Verify
          </button>
        )}
      </header>

      {connection === 'offline' ? (
        <p className={styles.banner} role="status">
          Offline — reconnecting. Messages you send are queued on this device.
        </p>
      ) : null}
      {blocked && peer ? (
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
      {group?.archived ? (
        <p className={styles.banner} role="status">
          This {group.kind === 'CHANNEL' ? 'channel' : 'group'} is archived. You can read it, but
          nobody can post.
        </p>
      ) : null}

      <div
        className={styles.log}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages === undefined ? <p className={styles.sidebarNote}>Loading messages…</p> : null}
        {messages?.length === 0 && events.length === 0 ? (
          <div className={styles.emptyConversation}>
            <p className={styles.emptyTitle}>
              {group ? `Welcome to ${title}` : `Say hello to ${title}`}
            </p>
            <p className={styles.sidebarNote}>
              {group
                ? 'Messages are end-to-end encrypted for the members’ devices — not readable by OGC. Members who join later can’t read earlier messages.'
                : `Messages are end-to-end encrypted. Only your and ${title}’s devices can read them — not OGC.`}
            </p>
          </div>
        ) : null}
        {items.map((item, index) => {
          const previous = items[index - 1];
          const newDay = !previous || !sameDay(previous.at, item.at);
          const separator = newDay ? (
            <p className={styles.day} role="separator">
              {dayLabel(item.at)}
            </p>
          ) : null;
          if (item.kind === 'event') {
            return (
              <Fragment key={`e-${item.event.id}`}>
                {separator}
                <p className={styles.timelineEvent}>
                  {describeEvent(item.event, nameOf, group?.kind ?? 'GROUP')}
                </p>
              </Fragment>
            );
          }
          const { message } = item;
          return (
            <Fragment key={message.clientMessageId}>
              {separator}
              <MessageBubble
                message={message}
                conversation={conversation}
                myOgcId={myOgcId}
                replyTarget={message.replyToId ? (byId.get(message.replyToId) ?? null) : undefined}
                actions={actions}
                senderName={group ? nameOf(message.senderOgcId) : undefined}
                canModerate={moderator && !group.archived}
              />
            </Fragment>
          );
        })}
        <div ref={bottom} />
      </div>

      {error ? <Alert>{error}</Alert> : null}
      {group && !group.canPost && !group.archived ? (
        <p className={styles.composerNote}>
          {group.postPolicy === 'MODERATORS'
            ? 'Only moderators and admins can post here.'
            : 'Only admins can post here.'}
        </p>
      ) : null}
      {writable || blocked ? (
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
      ) : null}

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
      {reporting ? (
        <ReportMessageDialog
          conversationId={conversation.id}
          message={reporting}
          senderName={nameOf(reporting.senderOgcId)}
          onClose={() => {
            setReporting(null);
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
      {showInfo && group ? (
        <Suspense fallback={<Spinner label="Loading group details" />}>
          <GroupInfoPanel
            conversation={conversation}
            members={members}
            onMembersChanged={setMembers}
            onClose={() => {
              setShowInfo(false);
            }}
          />
        </Suspense>
      ) : null}
      {confirmDelete ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Delete for everyone?">
          <p>
            {confirmDelete.mine
              ? 'Delete this message for everyone? It will be removed from OGC and from every member’s devices.'
              : `Remove this message from ${nameOf(confirmDelete.senderOgcId)} for everyone? The removal is recorded in the group history (without its content).`}{' '}
            Copies someone already saved or screenshotted can’t be recalled.
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
              {confirmDelete.mine ? 'Delete for everyone' : 'Remove for everyone'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
