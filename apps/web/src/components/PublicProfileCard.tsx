import type { PublicProfile } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { Avatar } from './Avatar';
import styles from './social.module.css';
import { Alert, Button } from './ui';

const RELATIONSHIP_LABEL: Record<PublicProfile['relationship'], string | null> = {
  SELF: 'This is you',
  NONE: null,
  OUTGOING_REQUEST: 'Request sent',
  INCOMING_REQUEST: 'Wants to connect with you',
  CONTACT: 'Contact',
  BLOCKED: 'Blocked',
};

type Pending = 'add' | 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';

/**
 * Another person's profile with the actions their relationship allows. After
 * every action the profile is re-read from the server, which stays the single
 * source of truth for relationship state.
 */
export function PublicProfileCard({
  profile,
  onChanged,
}: {
  profile: PublicProfile;
  onChanged: () => void;
}) {
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

  const label = RELATIONSHIP_LABEL[relationship];

  return (
    <article className={styles.card} aria-label={`Profile of ${profile.displayName}`}>
      <div className={styles.identityRow}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={72} />
        <div className={styles.names}>
          <h2 className={styles.displayName}>{profile.displayName}</h2>
          <span className={styles.ogcId}>{formatOgcIdForDisplay(ogcId)}</span>
        </div>
      </div>
      {label ? (
        <span
          className={[styles.badge, relationship === 'CONTACT' ? styles.badgeGold : ''].join(' ')}
        >
          {label}
        </span>
      ) : null}
      {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
      {profile.memberSince ? (
        <p className={styles.muted}>
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
          {profile.canSendContactRequest ? (
            <Button
              busy={busy === 'add'}
              onClick={() => void run('add', () => api.sendContactRequest(ogcId))}
            >
              Add contact
            </Button>
          ) : null}
          {relationship === 'NONE' && !profile.canSendContactRequest ? (
            <p className={styles.muted}>This person is not accepting contact requests.</p>
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
            confirm === 'remove' ? (
              <Button
                variant="secondary"
                busy={busy === 'remove'}
                onClick={() => void run('remove', () => api.removeContact(ogcId))}
              >
                Confirm remove
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirm('remove');
                }}
              >
                Remove contact
              </Button>
            )
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
      ) : null}

      {relationship !== 'SELF' ? (
        <div className={styles.secondaryActions}>
          {relationship !== 'BLOCKED' ? (
            confirm === 'block' ? (
              <Button
                variant="ghost"
                busy={busy === 'block'}
                onClick={() => void run('block', () => api.block(ogcId))}
              >
                Confirm block — removes them as a contact
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirm('block');
                }}
              >
                Block
              </Button>
            )
          ) : null}
          <Link className={styles.textLink} to={`/report/${ogcId}`}>
            Report
          </Link>
        </div>
      ) : null}
    </article>
  );
}
