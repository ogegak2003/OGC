import type { ContactView, ConversationView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
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
  const targets = conversations.filter((c) => c.id !== currentId && !c.blockedByMe);
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
              <Avatar url={target.peer.avatarUrl} name={target.peer.displayName} size={36} />
              <span className={styles.pickName}>{target.peer.displayName}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Shows the safety number both people can compare to rule out key substitution. */
export function SafetyNumberDialog({
  conversation,
  onClose,
}: {
  conversation: ConversationView;
  onClose: () => void;
}) {
  const { engine } = useMessaging();
  const [groups, setGroups] = useState<string[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!engine) return;
    let active = true;
    engine.safetyNumber(conversation.id).then(
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
  }, [engine, conversation.id]);

  return (
    <Modal title="Verify encryption" onClose={onClose}>
      <p className={styles.sidebarNote}>
        Compare this number with {conversation.peer.displayName} in person or on a call. If it
        matches on both devices, your messages are encrypted only for your and their devices. It
        changes when either of you adds or removes a device.
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
