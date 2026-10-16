import type { OwnProfile } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../lib/form';
import { shareIdentity, shareableIdentity } from '../lib/share';
import { Avatar } from './Avatar';
import styles from './IdentityCard.module.css';
import { Icon } from './Icon';
import { OgcMark } from './OgcMark';
import { OgcQrCode } from './OgcQrCode';
import { Button } from './ui';

/**
 * The OGC identity card: who you are on OGC, your OGC ID set large and legible, and the ways to
 * share it (copy, share, QR). Shows only what the person already sees about themselves; the
 * email address is never shown here (it is private by design).
 */
export function IdentityCard({ profile }: { profile: OwnProfile }) {
  const [notice, setNotice] = useState<string>();
  const [showQr, setShowQr] = useState(true);

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
    <section className={styles.card} aria-labelledby="ogc-id">
      <div className={styles.top}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={48} />
        <div className={styles.who}>
          <h2 id="ogc-id" className={styles.title}>
            Your OGC ID
          </h2>
          <p className={styles.name}>{profile.displayName}</p>
        </div>
        <OgcMark size={28} className={styles.mark} />
      </div>
      <p className={styles.ogcId} aria-label={profile.ogcId}>
        {formatOgcIdForDisplay(profile.ogcId)}
      </p>
      {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
      <div className={styles.actions}>
        <Button icon="copy" variant="secondary" onClick={() => void copyId()}>
          Copy
        </Button>
        <Button
          icon="share"
          variant="secondary"
          onClick={() =>
            void share().catch((e: unknown) => {
              setNotice(errorMessage(e));
            })
          }
        >
          Share
        </Button>
        <Button
          icon="qr"
          variant="ghost"
          aria-expanded={showQr}
          onClick={() => {
            setShowQr((value) => !value);
          }}
        >
          {showQr ? 'Hide QR' : 'QR code'}
        </Button>
      </div>
      <div className={styles.qr} hidden={!showQr}>
        <OgcQrCode ogcId={profile.ogcId} size={168} />
      </div>
      <p className={styles.live} role="status" aria-live="polite">
        {notice ?? ''}
      </p>
      <dl className={styles.facts}>
        <div>
          <dt>Profile visible to</dt>
          <dd>{profile.privacy.profileVisibility === 'EVERYONE' ? 'Everyone' : 'Contacts only'}</dd>
        </div>
        <div>
          <dt>Findable by OGC ID</dt>
          <dd>{profile.privacy.discoverable ? 'Yes' : 'Only by contacts'}</dd>
        </div>
      </dl>
      <p className={styles.note}>
        <Icon name="shieldCheck" size={16} />
        People find you by OGC ID or QR code. Your email address always stays private.
      </p>
      <Link to="/settings/privacy" className={styles.link}>
        Privacy settings
        <Icon name="arrowRight" size={14} />
      </Link>
    </section>
  );
}
