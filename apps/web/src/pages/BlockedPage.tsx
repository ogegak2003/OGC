import type { BlockView } from '@ogc/types';
import { useCallback, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog, EmptyState, PageIntro, PeopleList, PersonRow } from '../components/kit';
import kit from '../components/kit.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { listTime } from '../messaging/format';
import { useResource } from '../lib/use-resource';

/** People you blocked, with a confirmed way to unblock them. Photos are never shown here. */
export function BlockedPage() {
  const load = useCallback((signal: AbortSignal) => api.blocks(undefined, signal), []);
  const { state, reload } = useResource(load);
  const [error, setError] = useState<string>();
  const [unblocking, setUnblocking] = useState<BlockView>();
  const [busy, setBusy] = useState(false);

  async function unblock(block: BlockView) {
    setBusy(true);
    setError(undefined);
    try {
      await api.unblock(block.profile.ogcId);
      setUnblocking(undefined);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell title="Blocked people">
      <div className={kit.sectionBody}>
        <PageIntro>
          Blocked people cannot find you, see your profile, message or call you, or send you contact
          requests. They are not told that you blocked them.
        </PageIntro>
        {error && !unblocking ? <Alert>{error}</Alert> : null}
        {state.status === 'loading' ? <Spinner label="Loading" /> : null}
        {state.status === 'error' ? <Alert>{errorMessage(state.error)}</Alert> : null}
        {state.status === 'ready' && state.data.items.length === 0 ? (
          <EmptyState icon="ban" title="You have not blocked anyone.">
            You can block someone from their profile or from a conversation.
          </EmptyState>
        ) : null}
        {state.status === 'ready' && state.data.items.length > 0 ? (
          <PeopleList label="Blocked people">
            {state.data.items.map((b) => (
              <PersonRow
                key={b.profile.ogcId}
                profile={{ ...b.profile, avatarUrl: null }}
                meta={`Blocked ${listTime(b.blockedAt)}`}
              >
                <Button
                  variant="secondary"
                  onClick={() => {
                    setUnblocking(b);
                  }}
                >
                  Unblock
                </Button>
              </PersonRow>
            ))}
          </PeopleList>
        ) : null}
      </div>
      {unblocking ? (
        <ConfirmDialog
          title={`Unblock ${unblocking.profile.displayName}?`}
          confirmLabel="Unblock"
          tone="primary"
          busy={busy}
          error={error}
          onCancel={() => {
            setUnblocking(undefined);
            setError(undefined);
          }}
          onConfirm={() => void unblock(unblocking)}
        >
          <p>
            They will be able to find you by your OGC ID again (if your privacy settings allow) and
            send you a contact request. They are not added back as a contact.
          </p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
