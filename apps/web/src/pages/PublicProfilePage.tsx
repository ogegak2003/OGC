import { normalizeOgcId } from '@ogc/validation';
import { useCallback } from 'react';
import { useParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { PublicProfileCard } from '../components/PublicProfileCard';
import styles from '../components/social.module.css';
import { Alert, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { useResource } from '../lib/use-resource';

/**
 * Landing page for OGC identity links (`/id/OGC…`, the web form of
 * `ogc://id/OGC…`). Opening a link only shows the profile — adding the person
 * is always an explicit choice.
 */
export function PublicProfilePage() {
  const { ogcId: raw = '' } = useParams();
  const ogcId = normalizeOgcId(raw);
  const load = useCallback(
    (signal: AbortSignal) =>
      ogcId ? api.publicProfile(ogcId, signal) : Promise.reject(new ApiError(404, 'Not found')),
    [ogcId],
  );
  const { state, reload } = useResource(load);

  return (
    <AppShell title="OGC profile">
      {state.status === 'loading' ? <Spinner label="Loading profile" /> : null}
      {state.status === 'error' ? (
        state.error instanceof ApiError &&
        (state.error.status === 404 || state.error.status === 400) ? (
          <div className={styles.empty} role="status">
            This OGC profile is not available. The link may be wrong, or the account may not be
            visible to you.
          </div>
        ) : (
          <Alert>{errorMessage(state.error)}</Alert>
        )
      ) : null}
      {state.status === 'ready' ? (
        <PublicProfileCard profile={state.data} onChanged={reload} />
      ) : null}
    </AppShell>
  );
}
