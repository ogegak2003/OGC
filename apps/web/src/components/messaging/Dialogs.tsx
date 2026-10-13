import { type LocalMessage, conversationAvatar, conversationTitle } from '@ogc/messaging';
import type { ContactView, ConversationView, ReportCategory } from '@ogc/types';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { groupsApi } from '../../lib/community-api';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { Alert, Spinner } from '../ui';
import { Modal } from './Modal';
import styles from './messaging.module.css';

/** Pick a contact to message. Conversations can be started with contacts only. */
export function NewConversationDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (conversation: ConversationView) => void;
}) {
  const { engine } = useMessaging();
  const [contacts, setContacts] = useState<ContactView[]>();
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    api.contacts(undefined, controller.signal).then(
      (page) => {
        setContacts(page.items);
      },
      () => {
        if (!controller.signal.aborted) setError('Your contacts could not be loaded.');
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  const lowered = filter.trim().toLocaleLowerCase();
  const shown = (contacts ?? []).filter(
    (c) =>
      !lowered ||
      c.profile.displayName.toLocaleLowerCase().includes(lowered) ||
      c.profile.ogcId.toLowerCase().includes(lowered),
  );

  return (
    <Modal title="New conversation" onClose={onClose}>
      <input
        type="search"
        className={styles.search}
        placeholder="Search contacts"
        aria-label="Search contacts"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
      {error ? <Alert>{error}</Alert> : null}
      {!contacts && !error ? <Spinner label="Loading contacts" /> : null}
      {contacts?.length === 0 ? (
        <p className={styles.sidebarNote}>Add contacts from Discover to start messaging them.</p>
      ) : null}
      <ul className={styles.pickList}>
        {shown.map((contact) => (
          <li key={contact.profile.ogcId}>
            <button
              type="button"
              className={styles.pickRow}
              disabled={opening !== undefined}
              onClick={() => {
                if (!engine) return;
                setOpening(contact.profile.ogcId);
                setError(undefined);
                engine.openDirect(contact.profile.ogcId).then(onOpened, () => {
                  setOpening(undefined);
                  setError('This conversation could not be opened.');
                });
              }}
            >
              <Avatar
                url={contact.profile.avatarUrl}
                name={contact.profile.displayName}
                size={36}
              />
              <span className={styles.pickName}>{contact.profile.displayName}</span>
              <span className={styles.pickId}>{contact.profile.ogcId}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function ForwardDialog({
  currentId,
  onClose,
  onForward,
}: {
  currentId: string;
  onClose: () => void;
  onForward: (target: ConversationView) => Promise<void>;
}) {
  const { conversations } = useMessaging();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const targets = conversations.filter(
    (c) => c.id !== currentId && !c.blockedByMe && (c.group?.canPost ?? true),
  );
  return (
    <Modal title="Forward to…" onClose={onClose}>
      <p className={styles.sidebarNote}>
        The message is re-encrypted on this device for the new conversation. The recipient sees that
        it was forwarded, not who wrote it.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {targets.length === 0 ? (
        <p className={styles.sidebarNote}>No other conversations yet.</p>
      ) : null}
      <ul className={styles.pickList}>
        {targets.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              className={styles.pickRow}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onForward(target).then(onClose, () => {
                  setBusy(false);
                  setError('The message could not be forwarded.');
                });
              }}
            >
              <Avatar
                url={conversationAvatar(target).url}
                name={conversationTitle(target)}
                size={36}
              />
              <span className={styles.pickName}>{conversationTitle(target)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/**
 * Shows the safety number two people can compare to rule out key
 * substitution. In groups it is computed with one chosen member.
 */
export function SafetyNumberDialog({
  conversation,
  onClose,
  member,
}: {
  conversation: ConversationView;
  onClose: () => void;
  member?: { ogcId: string; displayName: string };
}) {
  const { engine } = useMessaging();
  const [groups, setGroups] = useState<string[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!engine) return;
    let active = true;
    engine.safetyNumber(conversation.id, member?.ogcId).then(
      (value) => {
        if (active) setGroups(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [engine, conversation.id, member?.ogcId]);

  const other = member?.displayName ?? conversation.peer?.displayName ?? 'them';
  return (
    <Modal title="Verify encryption" onClose={onClose}>
      <p className={styles.sidebarNote}>
        Compare this number with {other} in person or on a call. If it matches on both devices, your
        messages are encrypted only for your and their devices. It changes when either of you adds
        or removes a device.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {groups ? (
        <p className={styles.safetyNumber} aria-label={`Safety number ${groups.join(' ')}`}>
          {groups.map((group, index) => (
            <span key={index}>{group}</span>
          ))}
        </p>
      ) : !error ? (
        <Spinner label="Computing safety number" />
      ) : null}
    </Modal>
  );
}

const REPORT_CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: 'SPAM', label: 'Spam' },
  { value: 'HARASSMENT', label: 'Harassment' },
  { value: 'IMPERSONATION', label: 'Impersonation' },
  { value: 'INAPPROPRIATE_CONTENT', label: 'Inappropriate content' },
  { value: 'SCAM_OR_FRAUD', label: 'Scam or fraud' },
  { value: 'OTHER', label: 'Something else' },
];

/**
 * Reports a message from an end-to-end encrypted conversation. OGC cannot
 * read it, so the reporter decides whether to share the decrypted text —
 * shown here exactly as it would be sent.
 */
export function ReportMessageDialog({
  conversationId,
  message,
  senderName,
  onClose,
}: {
  conversationId: string;
  message: LocalMessage;
  senderName: string;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<ReportCategory>('HARASSMENT');
  const [disclose, setDisclose] = useState(false);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const text = message.payload?.text ?? '';

  return (
    <Modal title="Report message" onClose={onClose}>
      {done ? (
        <>
          <Alert tone="success">Thanks — your report was sent to OGC’s safety team.</Alert>
          <button type="button" className={styles.primaryLink} onClick={onClose}>
            Close
          </button>
        </>
      ) : (
        <form
          className={styles.formStack}
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            groupsApi
              .report(conversationId, {
                category,
                ...(message.id ? { messageId: message.id } : {}),
                ...(message.senderOgcId ? { reportedOgcId: message.senderOgcId } : {}),
                ...(disclose && text ? { disclosedText: text } : {}),
                ...(description.trim() ? { description: description.trim() } : {}),
              })
              .then(
                () => {
                  setDone(true);
                },
                () => {
                  setBusy(false);
                  setError('The report could not be sent. Please try again.');
                },
              );
          }}
        >
          <p className={styles.sidebarNote}>
            You’re reporting a message from {senderName}. Messages are end-to-end encrypted, so OGC
            can only see its text if you choose to include it.
          </p>
          <label className={styles.formStack}>
            <span>Reason</span>
            <select
              className={styles.select}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as ReportCategory);
              }}
            >
              {REPORT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {text ? (
            <>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={disclose}
                  onChange={(event) => {
                    setDisclose(event.target.checked);
                  }}
                />
                <span>
                  Include the message text below (OGC’s safety team will be able to read it)
                </span>
              </label>
              {disclose ? <p className={styles.disclosure}>{text}</p> : null}
            </>
          ) : null}
          <label className={styles.formStack}>
            <span>Details (optional)</span>
            <textarea
              className={styles.textarea}
              maxLength={1000}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </label>
          {error ? <Alert>{error}</Alert> : null}
          <button type="submit" className={styles.newButton} disabled={busy}>
            Send report
          </button>
        </form>
      )}
    </Modal>
  );
}
