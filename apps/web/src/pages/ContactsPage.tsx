import type { ContactRequestView, ContactView, Page, ProfileSummary } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { type ReactNode, useCallback, useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import styles from '../components/social.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { useResource } from '../lib/use-resource';

type Tab = 'contacts' | 'incoming' | 'outgoing';

function PersonRow({ profile, children }: { profile: ProfileSummary; children?: ReactNode }) {
  return (
    <li className={styles.listItem}>
      <Link to={`/id/${profile.ogcId}`} className={`${styles.identityRow} ${styles.listLink}`}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={44} />
        <span className={styles.names}>
          <span className={styles.displayNameSmall}>{profile.displayName}</span>
          <span className={styles.ogcId}>{formatOgcIdForDisplay(profile.ogcId)}</span>
        </span>
      </Link>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </li>
  );
}

/** A paginated list with "Load more" (cursor pagination). */
function usePagedList<T>(load: (cursor?: string) => Promise<Page<T>>) {
  const first = useCallback(() => load(), [load]);
  const { state, reload, set } = useResource(first);
  const [loadingMore, setLoadingMore] = useState(false);

  async function more() {
    if (state.status !== 'ready' || !state.data.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await load(state.data.nextCursor);
      set({ items: [...state.data.items, ...next.items], nextCursor: next.nextCursor });
    } finally {
      setLoadingMore(false);
    }
  }
  return { state, reload, more, loadingMore };
}

function ListView<T>({
  list,
  empty,
  render,
}: {
  list: ReturnType<typeof usePagedList<T>>;
  empty: string;
  render: (item: T) => ReactNode;
}) {
  const { state } = list;
  if (state.status === 'loading') return <Spinner label="Loading" />;
  if (state.status === 'error') return <Alert>{errorMessage(state.error)}</Alert>;
  if (state.data.items.length === 0) return <div className={styles.empty}>{empty}</div>;
  return (
    <>
      <ul className={styles.list}>{state.data.items.map(render)}</ul>
      {state.data.nextCursor ? (
        <Button variant="secondary" busy={list.loadingMore} onClick={() => void list.more()}>
          Load more
        </Button>
      ) : null}
    </>
  );
}

export function ContactsPage() {
  const [tab, setTab] = useState<Tab>('contacts');
  const [error, setError] = useState<string>();
  const contacts = usePagedList<ContactView>(useCallback((c?: string) => api.contacts(c), []));
  const incoming = usePagedList<ContactRequestView>(
    useCallback((c?: string) => api.incomingRequests(c), []),
  );
  const outgoing = usePagedList<ContactRequestView>(
    useCallback((c?: string) => api.outgoingRequests(c), []),
  );

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
    contacts.reload();
    incoming.reload();
    outgoing.reload();
  }

  const incomingCount =
    incoming.state.status === 'ready' ? incoming.state.data.items.length : undefined;
  const tabs: { id: Tab; label: string; count?: number | undefined }[] = [
    { id: 'contacts', label: 'Contacts' },
    { id: 'incoming', label: 'Requests', count: incomingCount },
    { id: 'outgoing', label: 'Sent' },
  ];

  return (
    <AppShell title="Contacts">
      <div className={styles.tabs} role="tablist" aria-label="Contacts">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={styles.tab}
            onClick={() => {
              setTab(t.id);
            }}
          >
            {t.label}
            {t.count ? <span className={styles.count}>{t.count}</span> : null}
          </button>
        ))}
      </div>
      {error ? <Alert>{error}</Alert> : null}

      <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'contacts' ? (
          <ListView
            list={contacts}
            empty="No contacts yet. Find people by their OGC ID in Discover."
            render={(c) => <PersonRow key={c.profile.ogcId} profile={c.profile} />}
          />
        ) : null}
        {tab === 'incoming' ? (
          <ListView
            list={incoming}
            empty="No pending requests."
            render={(r) => (
              <PersonRow key={r.id} profile={r.profile}>
                <Button onClick={() => void act(() => api.acceptRequest(r.id))}>Accept</Button>
                <Button
                  variant="secondary"
                  onClick={() => void act(() => api.declineRequest(r.id))}
                >
                  Decline
                </Button>
              </PersonRow>
            )}
          />
        ) : null}
        {tab === 'outgoing' ? (
          <ListView
            list={outgoing}
            empty="You have no requests waiting for an answer."
            render={(r) => (
              <PersonRow key={r.id} profile={r.profile}>
                <Button variant="secondary" onClick={() => void act(() => api.cancelRequest(r.id))}>
                  Cancel
                </Button>
              </PersonRow>
            )}
          />
        ) : null}
      </section>
    </AppShell>
  );
}
