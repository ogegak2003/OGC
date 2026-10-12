import { formatOgcIdForDisplay } from '@ogc/validation';
import { useCallback, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import styles from '../components/social.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { useResource } from '../lib/use-resource';

export function BlockedPage() {
  const load = useCallback((signal: AbortSignal) => api.blocks(undefined, signal), []);
  const { state, reload } = useResource(load);
  const [error, setError] = useState<string>();

  async function unblock(ogcId: string) {
    setError(undefined);
    try {
      await api.unblock(ogcId);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <AppShell title="Blocked people">
      <p className={styles.muted}>
        Blocked people cannot find you, see your profile, or send you contact requests. They are not
        told that you blocked them.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {state.status === 'loading' ? <Spinner label="Loading" /> : null}
      {state.status === 'error' ? <Alert>{errorMessage(state.error)}</Alert> : null}
      {state.status === 'ready' && state.data.items.length === 0 ? (
        <div className={styles.empty}>You have not blocked anyone.</div>
      ) : null}
      {state.status === 'ready' && state.data.items.length > 0 ? (
        <ul className={styles.list}>
          {state.data.items.map((b) => (
            <li key={b.profile.ogcId} className={styles.listItem}>
              <span className={styles.identityRow}>
                <Avatar url={null} name={b.profile.displayName} size={40} />
                <span className={styles.names}>
                  <span className={styles.displayNameSmall}>{b.profile.displayName}</span>
                  <span className={styles.ogcId}>{formatOgcIdForDisplay(b.profile.ogcId)}</span>
                </span>
              </span>
              <Button variant="secondary" onClick={() => void unblock(b.profile.ogcId)}>
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </AppShell>
  );
}
