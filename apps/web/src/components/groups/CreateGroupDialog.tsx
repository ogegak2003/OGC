import type { ContactView, ConversationView } from '@ogc/types';
import {
  COMMUNITY_NAME_MAX_LENGTH,
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_MEMBER_LIMIT,
} from '@ogc/validation';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { groupsApi } from '../../lib/community-api';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { Modal } from '../messaging/Modal';
import styles from '../messaging/messaging.module.css';
import { Alert, Spinner } from '../ui';

/**
 * Creates a private group or private encrypted channel and invites contacts.
 * Invited people join only after accepting.
 */
export function CreateGroupDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (conversation: ConversationView) => void;
}) {
  const { engine } = useMessaging();
  const [kind, setKind] = useState<'GROUP' | 'CHANNEL'>('GROUP');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [contacts, setContacts] = useState<ContactView[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    api.contacts(undefined, controller.signal).then(
      (page) => {
        setContacts(page.items);
      },
      () => {
        if (!controller.signal.aborted) setContacts([]);
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  const toggle = (ogcId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(ogcId)) next.delete(ogcId);
      else if (next.size < GROUP_MEMBER_LIMIT - 1) next.add(ogcId);
      return next;
    });
  };

  return (
    <Modal title={kind === 'GROUP' ? 'New group' : 'New encrypted channel'} onClose={onClose}>
      <form
        className={styles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) {
            setError('Give it a name.');
            return;
          }
          setBusy(true);
          setError(undefined);
          groupsApi
            .create({
              kind,
              name: name.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(selected.size ? { invite: [...selected] } : {}),
            })
            .then(
              async ({ conversation }) => {
                await engine?.refreshConversations().catch(() => undefined);
                onCreated(conversation);
              },
              (cause: unknown) => {
                setBusy(false);
                setError(cause instanceof Error ? cause.message : 'It could not be created.');
              },
            );
        }}
      >
        <div className={styles.segmented} role="radiogroup" aria-label="Type">
          {(['GROUP', 'CHANNEL'] as const).map((value) => (
            <label key={value} className={kind === value ? styles.segmentActive : styles.segment}>
              <input
                type="radio"
                name="kind"
                value={value}
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                }}
              />
              {value === 'GROUP' ? 'Group' : 'Encrypted channel'}
            </label>
          ))}
        </div>
        <p className={styles.sidebarNote}>
          {kind === 'GROUP'
            ? `Up to ${String(GROUP_MEMBER_LIMIT)} people. Everyone can post. Messages are end-to-end encrypted.`
            : 'A broadcast for up to 32 people: admins post, members read and react. End-to-end encrypted.'}
        </p>
        <label className={styles.formStack}>
          <span>Name</span>
          <input
            className={styles.search}
            value={name}
            maxLength={COMMUNITY_NAME_MAX_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
          />
        </label>
        <label className={styles.formStack}>
          <span>Description (optional)</span>
          <textarea
            className={styles.textarea}
            value={description}
            maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
        <fieldset className={styles.fieldset}>
          <legend>Invite contacts ({selected.size} selected)</legend>
          {!contacts ? <Spinner label="Loading contacts" /> : null}
          {contacts?.length === 0 ? (
            <p className={styles.sidebarNote}>You can invite people later.</p>
          ) : null}
          <ul className={styles.pickList}>
            {contacts?.map((contact) => (
              <li key={contact.profile.ogcId}>
                <label className={styles.pickRow}>
                  <input
                    type="checkbox"
                    checked={selected.has(contact.profile.ogcId)}
                    onChange={() => {
                      toggle(contact.profile.ogcId);
                    }}
                  />
                  <Avatar
                    url={contact.profile.avatarUrl}
                    name={contact.profile.displayName}
                    size={32}
                  />
                  <span className={styles.pickName}>{contact.profile.displayName}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <p className={styles.sidebarNote}>
          The name, description, photo and member list are visible to OGC so it can deliver
          messages; message content is not.
        </p>
        {error ? <Alert>{error}</Alert> : null}
        <button type="submit" className={styles.newButton} disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </form>
    </Modal>
  );
}
