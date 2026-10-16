import type { PublicProfile } from '@ogc/types';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { useMessaging } from '../messaging/messaging-context';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { ConfirmDialog, OgcIdBadge } from './kit';
import styles from './PublicProfileCard.module.css';
import { Alert, Button } from './ui';

const RELATIONSHIP_LABEL: Record<PublicProfile['relationship'], string | null> = {
  SELF: 'This is you',
  NONE: null,
  OUTGOING_REQUEST: 'Request sent',
  INCOMING_REQUEST: 'Wants to connect with you',
  CONTACT: 'Contact',
  BLOCKED: 'Blocked',
};

type Pending = 'add' | 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock' | 'message';

/**
 * Another person's profile with the actions their relationship allows. After every action the
 * profile is re-read from the server, which stays the single source of truth for relationship
 * state. Only what the person's privacy settings allow is shown (the server decides).
 */
export function PublicProfileCard({
  profile,
  onChanged,
}: {
  profile: PublicProfile;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const { engine } = useMessaging();
  const [busy, setBusy] = useState<Pending>();
  const [confirm, setConfirm] = useState<'remove' | 'block'>();
  const [error, setError] = useState<string>();
  const { ogcId, relationship, pendingRequestId } = profile;

  async function run(kind: Pending, action: () => Promise<unknown>) {
    setBusy(kind);
    setError(undefined);
    try {
      await action();
      setConfirm(undefined);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function message() {
    if (!engine) return;
    setBusy('message');
    setError(undefined);
    try {
      const conversation = await engine.openDirect(ogcId);
      void navigate(`/messages/${conversation.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const label = RELATIONSHIP_LABEL[relationship];

  return (
    <article className={styles.card} aria-label={`Profile of ${profile.displayName}`}>
      <div className={styles.band} aria-hidden="true" />
      <div className={styles.head}>
        <span className={styles.avatar}>
          <Avatar url={profile.avatarUrl} name={profile.displayName} size={88} />
        </span>
        <div className={styles.names}>
          <h2 className={styles.name}>{profile.displayName}</h2>
          <OgcIdBadge ogcId={ogcId} />
        </div>
        {label ? (
          <span
            className={[
              styles.tag,
              relationship === 'CONTACT' ? styles.tagContact : '',
              relationship === 'BLOCKED' ? styles.tagBlocked : '',
            ].join(' ')}
          >
            {label}
          </span>
        ) : null}
      </div>

      {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
      {profile.memberSince ? (
        <p className={styles.meta}>
          <Icon name="clock" size={14} />
          On OGC since{' '}
          {new Date(profile.memberSince).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
          })}
        </p>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}

      {relationship !== 'SELF' ? (
        <div className={styles.actions}>
          {relationship === 'CONTACT' && engine ? (
            <Button icon="chat" busy={busy === 'message'} onClick={() => void message()}>
              Message
            </Button>
          ) : null}
          {profile.canSendContactRequest ? (
            <Button
              icon="userPlus"
              busy={busy === 'add'}
              onClick={() => void run('add', () => api.sendContactRequest(ogcId))}
            >
              Add contact
            </Button>
          ) : null}
          {relationship === 'NONE' && !profile.canSendContactRequest ? (
            <p className={styles.meta}>This person is not accepting contact requests.</p>
          ) : null}
          {relationship === 'INCOMING_REQUEST' && pendingRequestId ? (
            <>
              <Button
                busy={busy === 'accept'}
                onClick={() => void run('accept', () => api.acceptRequest(pendingRequestId))}
              >
                Accept
              </Button>
              <Button
                variant="secondary"
                busy={busy === 'decline'}
                onClick={() => void run('decline', () => api.declineRequest(pendingRequestId))}
              >
                Decline
              </Button>
            </>
          ) : null}
          {relationship === 'OUTGOING_REQUEST' && pendingRequestId ? (
            <Button
              variant="secondary"
              busy={busy === 'cancel'}
              onClick={() => void run('cancel', () => api.cancelRequest(pendingRequestId))}
            >
              Cancel request
            </Button>
          ) : null}
          {relationship === 'CONTACT' ? (
            <Button
              variant="secondary"
              onClick={() => {
                setConfirm('remove');
              }}
            >
              Remove contact
            </Button>
          ) : null}
          {relationship === 'BLOCKED' ? (
            <Button
              variant="secondary"
              busy={busy === 'unblock'}
              onClick={() => void run('unblock', () => api.unblock(ogcId))}
            >
              Unblock
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={styles.actions}>
          <Link to="/profile/edit" className={styles.link}>
            <Icon name="edit" size={16} />
            Edit your profile
          </Link>
        </div>
      )}

      {relationship !== 'SELF' ? (
        <div className={styles.safety}>
          {relationship !== 'BLOCKED' ? (
            <button
              type="button"
              className={styles.safetyAction}
              onClick={() => {
                setConfirm('block');
              }}
            >
              <Icon name="ban" size={16} />
              Block
            </button>
          ) : null}
          <Link className={styles.safetyAction} to={`/report/${ogcId}`}>
            <Icon name="flag" size={16} />
            Report
          </Link>
        </div>
      ) : null}

      {confirm === 'remove' ? (
        <ConfirmDialog
          title={`Remove ${profile.displayName}?`}
          confirmLabel="Remove contact"
          busy={busy === 'remove'}
          error={error}
          onCancel={() => {
            setConfirm(undefined);
          }}
          onConfirm={() => void run('remove', () => api.removeContact(ogcId))}
        >
          <p>
            They are removed from your contacts. Your conversation history stays on your devices.
            You can send a new request later.
          </p>
        </ConfirmDialog>
      ) : null}
      {confirm === 'block' ? (
        <ConfirmDialog
          title={`Block ${profile.displayName}?`}
          confirmLabel="Confirm block"
          busy={busy === 'block'}
          error={error}
          onCancel={() => {
            setConfirm(undefined);
          }}
          onConfirm={() => void run('block', () => api.block(ogcId))}
        >
          <p>
            Blocking removes them as a contact. They can no longer find your profile, message or
            call you, or send you requests. They are not told.
          </p>
        </ConfirmDialog>
      ) : null}
    </article>
  );
}
