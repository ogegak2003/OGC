import type { ContactRequestView, ContactView, Page } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import type { IconName } from '../components/Icon';
import {
  ConfirmDialog,
  EmptyState,
  FilterField,
  LinkButton,
  PageIntro,
  PeopleList,
  PersonRow,
  SegmentedTabs,
} from '../components/kit';
import { tabId, tabPanelId } from '../components/kit-ids';
import kit from '../components/kit.module.css';
import { Alert, Button, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { useResource } from '../lib/use-resource';
import { listTime } from '../messaging/format';
import { useMessaging } from '../messaging/messaging-context';

type Tab = 'contacts' | 'incoming' | 'outgoing';

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
  label,
  empty,
  filter,
  render,
}: {
  list: ReturnType<typeof usePagedList<T>>;
  label: string;
  empty: { icon: IconName; title: string; text: string; action?: ReactNode };
  filter?: (item: T) => boolean;
  render: (item: T) => ReactNode;
}) {
  const { state } = list;
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading" className={kit.people}>
        {[0, 1, 2].map((key) => (
          <div key={key} className={kit.person}>
            <span className={kit.personLink}>
              <Skeleton width="2.75rem" height="2.75rem" round />
              <span className={kit.personText}>
                <Skeleton width="9rem" />
                <Skeleton width="6rem" height="0.7rem" />
              </span>
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (state.status === 'error') return <Alert>{errorMessage(state.error)}</Alert>;
  if (state.data.items.length === 0) {
    return (
      <EmptyState icon={empty.icon} title={empty.title} action={empty.action}>
        {empty.text}
      </EmptyState>
    );
  }
  const items = filter ? state.data.items.filter(filter) : state.data.items;
  return (
    <>
      {items.length === 0 ? (
        <EmptyState icon="search" title="No matches">
          Nobody in your loaded contacts matches that name or OGC ID.
        </EmptyState>
      ) : (
        <PeopleList label={label}>{items.map(render)}</PeopleList>
      )}
      {state.data.nextCursor ? (
        <Button variant="secondary" busy={list.loadingMore} onClick={() => void list.more()}>
          Load more
        </Button>
      ) : null}
    </>
  );
}

/**
 * Contacts: your contacts (with presence where it is shared), requests waiting for your answer,
 * and requests you sent. The filter narrows what is loaded; finding new people is by exact OGC
 * ID only (Discover), as the service supports.
 */
export function ContactsPage() {
  const { presence, watchPresence } = useMessaging();
  // `?tab=requests` (from notifications) opens the requests waiting for an answer.
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'requests' ? 'incoming' : 'contacts');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState<ContactRequestView>();
  const [busy, setBusy] = useState(false);
  const contacts = usePagedList<ContactView>(useCallback((c?: string) => api.contacts(c), []));
  const incoming = usePagedList<ContactRequestView>(
    useCallback((c?: string) => api.incomingRequests(c), []),
  );
  const outgoing = usePagedList<ContactRequestView>(
    useCallback((c?: string) => api.outgoingRequests(c), []),
  );

  // Presence is shared between contacts: watch the loaded ones.
  const contactIds = useMemo(
    () =>
      contacts.state.status === 'ready'
        ? contacts.state.data.items.map((c) => c.profile.ogcId)
        : [],
    [contacts.state],
  );
  useEffect(() => {
    if (contactIds.length > 0) watchPresence(contactIds);
  }, [contactIds, watchPresence]);

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
    contacts.reload();
    incoming.reload();
    outgoing.reload();
  }

  const incomingCount =
    incoming.state.status === 'ready' ? incoming.state.data.items.length : undefined;
  const normalized = query.trim().toLowerCase().replace(/\s+/g, '');
  const matches = (contact: ContactView) =>
    !normalized ||
    contact.profile.displayName.toLowerCase().replace(/\s+/g, '').includes(normalized) ||
    contact.profile.ogcId.toLowerCase().includes(normalized) ||
    formatOgcIdForDisplay(contact.profile.ogcId)
      .toLowerCase()
      .replace(/\s+/g, '')
      .includes(normalized);

  const findAction = (
    <LinkButton to="/discover" icon="userPlus">
      Find by OGC ID
    </LinkButton>
  );

  return (
    <AppShell title="Contacts">
      <div className={kit.sectionBody}>
        <PageIntro actions={findAction}>
          People you have connected with. Add someone by their exact OGC ID — OGC has no public
          directory, so nobody can browse your contacts.
        </PageIntro>
        <SegmentedTabs
          label="Contacts"
          prefix="contacts"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'contacts', label: 'Contacts' },
            { id: 'incoming', label: 'Requests', count: incomingCount },
            { id: 'outgoing', label: 'Sent' },
          ]}
        />
        {error ? <Alert>{error}</Alert> : null}

        <section
          id={tabPanelId('contacts', tab)}
          role="tabpanel"
          aria-labelledby={tabId('contacts', tab)}
          className={kit.sectionBody}
        >
          {tab === 'contacts' ? (
            <>
              {contacts.state.status === 'ready' && contacts.state.data.items.length > 0 ? (
                <FilterField
                  label="Filter contacts"
                  placeholder="Filter by name or OGC ID"
                  value={query}
                  onChange={setQuery}
                />
              ) : null}
              <ListView
                list={contacts}
                label="Your contacts"
                filter={matches}
                empty={{
                  icon: 'contacts',
                  title: 'No contacts yet',
                  text: 'Find people by their OGC ID, then send them a contact request.',
                  action: (
                    <LinkButton to="/discover" icon="userPlus" variant="primary">
                      Find someone
                    </LinkButton>
                  ),
                }}
                render={(c) => (
                  <PersonRow
                    key={c.profile.ogcId}
                    profile={c.profile}
                    online={
                      presence[c.profile.ogcId] === undefined
                        ? undefined
                        : presence[c.profile.ogcId] === 'ONLINE'
                    }
                  />
                )}
              />
            </>
          ) : null}
          {tab === 'incoming' ? (
            <ListView
              list={incoming}
              label="Requests waiting for your answer"
              empty={{
                icon: 'inbox',
                title: 'No pending requests',
                text: 'When someone asks to connect with you, their request appears here.',
              }}
              render={(r) => (
                <PersonRow key={r.id} profile={r.profile} meta={`Asked ${listTime(r.createdAt)}`}>
                  <Button busy={busy} onClick={() => void act(() => api.acceptRequest(r.id))}>
                    Accept
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
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
              label="Requests you sent"
              empty={{
                icon: 'clock',
                title: 'Nothing waiting',
                text: 'Requests you send stay here until they are answered.',
              }}
              render={(r) => (
                <PersonRow key={r.id} profile={r.profile} meta={`Sent ${listTime(r.createdAt)}`}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setCancelling(r);
                    }}
                  >
                    Cancel
                  </Button>
                </PersonRow>
              )}
            />
          ) : null}
        </section>
      </div>
      {cancelling ? (
        <ConfirmDialog
          title="Cancel this request?"
          confirmLabel="Cancel request"
          busy={busy}
          onCancel={() => {
            setCancelling(undefined);
          }}
          onConfirm={() => {
            const request = cancelling;
            void act(() => api.cancelRequest(request.id)).then(() => {
              setCancelling(undefined);
            });
          }}
        >
          <p>
            {cancelling.profile.displayName} will no longer see your request. You can send a new one
            later.
          </p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
