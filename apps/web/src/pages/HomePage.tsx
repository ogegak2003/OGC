import { formatOgcIdForDisplay } from '@ogc/validation';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { OgcQrCode } from '../components/OgcQrCode';
import { Alert, Button, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { shareIdentity, shareableIdentity } from '../lib/share';
import { useResource } from '../lib/use-resource';
import styles from './HomePage.module.css';

/** "My OGC": the signed-in user's identity, QR code, sharing and profile. */
export function HomePage() {
  const { state: auth } = useAuth();
  const load = useCallback((signal: AbortSignal) => api.profile(signal), []);
  const { state } = useResource(load);
  const [notice, setNotice] = useState<string>();

  if (state.status === 'loading') return <Spinner label="Loading your profile" />;
  if (state.status === 'error') {
    return (
      <AppShell title="My OGC">
        <Alert>{errorMessage(state.error)}</Alert>
      </AppShell>
    );
  }
  const profile = state.data;
  const email = auth.status === 'signed-in' ? auth.account.email : '';

  async function share() {
    const result = await shareIdentity(
      shareableIdentity(profile.ogcId, profile.displayName, window.location.origin),
    );
    setNotice(result === 'copied' ? 'Your OGC details were copied to the clipboard.' : undefined);
  }

  async function copyId() {
    await navigator.clipboard.writeText(profile.ogcId);
    setNotice('OGC ID copied.');
  }

  return (
    <AppShell title="My OGC">
      <section className={styles.identity} aria-labelledby="ogc-id-label">
        <div className={styles.identityText}>
          <div className={styles.person}>
            <Avatar url={profile.avatarUrl} name={profile.displayName} size={64} />
            <div>
              <p className={styles.displayName}>{profile.displayName}</p>
              <Link className={styles.edit} to="/profile/edit">
                Edit profile
              </Link>
            </div>
          </div>
          <h2 id="ogc-id-label" className={styles.label}>
            Your OGC ID
          </h2>
          <p className={styles.ogcId} aria-label={profile.ogcId}>
            {formatOgcIdForDisplay(profile.ogcId)}
          </p>
          {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
          <p className={styles.explainer}>
            Share your OGC ID or QR code so people can find you. Your email address and phone number
            always stay private.
          </p>
          <div className={styles.actions}>
            <Button
              onClick={() =>
                void share().catch((e: unknown) => {
                  setNotice(errorMessage(e));
                })
              }
            >
              Share my OGC
            </Button>
            <Button variant="secondary" onClick={() => void copyId()}>
              Copy OGC ID
            </Button>
          </div>
          <p className={styles.liveRegion} role="status" aria-live="polite">
            {notice ?? ''}
          </p>
        </div>
        <OgcQrCode ogcId={profile.ogcId} />
      </section>

      <section className={styles.details} aria-labelledby="account-heading">
        <h2 id="account-heading" className={styles.sectionTitle}>
          Account
        </h2>
        <dl className={styles.list}>
          <div>
            <dt>Email</dt>
            <dd>
              {email}
              <span className={styles.badge}>Private</span>
            </dd>
          </div>
          <div>
            <dt>Profile visible to</dt>
            <dd>
              {profile.privacy.profileVisibility === 'EVERYONE' ? 'Everyone' : 'Contacts only'}
            </dd>
          </div>
          <div>
            <dt>Findable by OGC ID</dt>
            <dd>{profile.privacy.discoverable ? 'Yes' : 'Only by contacts'}</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>
              {new Date(profile.memberSince).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </dd>
          </div>
        </dl>
        <Link className={styles.edit} to="/settings/privacy">
          Privacy settings
        </Link>
      </section>
    </AppShell>
  );
}
