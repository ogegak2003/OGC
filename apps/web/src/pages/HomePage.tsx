import { formatOgcIdForDisplay } from '@ogc/validation';
import { useState } from 'react';
import { useAuth } from '../auth/auth-context';
import { OgcMark } from '../components/OgcMark';
import { OgcQrCode } from '../components/OgcQrCode';
import { Button } from '../components/ui';
import styles from './HomePage.module.css';

const STATUS_LABEL = {
  ACTIVE: 'Active',
  PENDING_VERIFICATION: 'Pending verification',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
} as const;

export function HomePage() {
  const { state, logout } = useAuth();
  const [copied, setCopied] = useState(false);
  if (state.status !== 'signed-in') return null;
  const { account } = state;

  async function copy() {
    await navigator.clipboard.writeText(account.ogcId);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo}>
          <OgcMark size={30} />
          OGC
        </span>
        <Button variant="ghost" onClick={() => void logout()}>
          Sign out
        </Button>
      </header>

      <main className={styles.main}>
        <p className={styles.greeting}>Welcome, {account.displayName}</p>

        <section className={styles.identity} aria-labelledby="ogc-id-label">
          <div className={styles.identityText}>
            <h1 id="ogc-id-label" className={styles.label}>
              Your OGC ID
            </h1>
            <p className={styles.ogcId} aria-label={account.ogcId}>
              {formatOgcIdForDisplay(account.ogcId)}
            </p>
            <p className={styles.explainer}>
              Share your OGC ID or QR code so people can find you. Your email address and phone
              number always stay private.
            </p>
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy OGC ID'}
              </Button>
              <span className={styles.liveRegion} role="status" aria-live="polite">
                {copied ? 'OGC ID copied to clipboard' : ''}
              </span>
            </div>
          </div>
          <OgcQrCode ogcId={account.ogcId} />
        </section>

        <section className={styles.details} aria-labelledby="account-heading">
          <h2 id="account-heading" className={styles.sectionTitle}>
            Account
          </h2>
          <dl className={styles.list}>
            <div>
              <dt>Display name</dt>
              <dd>{account.displayName}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                {account.email}
                {account.emailVerified ? <span className={styles.badge}>Verified</span> : null}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{STATUS_LABEL[account.accountStatus]}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>
                {new Date(account.createdAt).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  );
}
