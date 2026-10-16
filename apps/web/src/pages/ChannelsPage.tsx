import type { ChannelView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { CreateChannelDialog } from '../components/channels/CreateChannelDialog';
import { CardGrid, ChannelCard } from '../components/community/CommunityCards';
import community from '../components/community/community.module.css';
import { EmptyState, FilterField, PageIntro, SegmentedTabs } from '../components/kit';
import { tabId, tabPanelId } from '../components/kit-ids';
import { Alert, Button, Skeleton } from '../components/ui';
import { channelsApi } from '../lib/community-api';

type Tab = 'mine' | 'discover';

function LoadingCards({ label }: { label: string }) {
  return (
    <div className={community.grid} role="status" aria-label={label}>
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} height="6.5rem" />
      ))}
    </div>
  );
}

/** `/channels`: the user's community channels and the public directory with search. */
export function ChannelsPage() {
  const navigate = useNavigate();
  // `?q=` comes from the global search: open the public directory with that search.
  const [params] = useSearchParams();
  const initialQuery = params.get('q') ?? '';
  const [tab, setTab] = useState<Tab>(initialQuery ? 'discover' : 'mine');
  const [mine, setMine] = useState<ChannelView[]>();
  const [query, setQuery] = useState(initialQuery);
  const [found, setFound] = useState<ChannelView[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    channelsApi.mine(controller.signal).then(setMine, () => {
      if (!controller.signal.aborted) setError('Your channels could not be loaded.');
    });
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (tab !== 'discover') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      channelsApi.discover(query, undefined, controller.signal).then(
        (page) => {
          setFound(page.items);
          setCursor(page.nextCursor);
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(
            (cause as { status?: number }).status === 429
              ? 'Too many searches — please wait a moment.'
              : 'Search failed.',
          );
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tab, query]);

  const unread = mine?.reduce((sum, channel) => sum + channel.unreadCount, 0) ?? 0;

  return (
    <AppShell title="Channels">
      <div className={community.page}>
        <PageIntro
          actions={
            <Button
              icon="plus"
              onClick={() => {
                setCreating(true);
              }}
            >
              New channel
            </Button>
          }
        >
          Community channels are open spaces for announcements and discussion with larger audiences.
          They are not end-to-end encrypted — use groups for private conversations.
        </PageIntro>

        <SegmentedTabs
          label="Channels"
          prefix="channels"
          value={tab}
          onChange={(value) => {
            setTab(value);
            setError(undefined);
          }}
          options={[
            { id: 'mine', label: 'My channels', count: unread || undefined, countLabel: 'unread' },
            { id: 'discover', label: 'Discover' },
          ]}
        />
        {error ? <Alert>{error}</Alert> : null}

        <div
          role="tabpanel"
          id={tabPanelId('channels', tab)}
          aria-labelledby={tabId('channels', tab)}
          className={community.section}
        >
          {tab === 'mine' ? (
            <>
              {!mine && !error ? <LoadingCards label="Loading channels" /> : null}
              {mine?.length === 0 ? (
                <EmptyState icon="megaphone" title="No channels yet">
                  You haven’t joined any channels yet. Find some in Discover.
                </EmptyState>
              ) : null}
              {mine?.length ? (
                <CardGrid label="My channels">
                  {mine.map((channel) => (
                    <ChannelCard key={channel.id} channel={channel} />
                  ))}
                </CardGrid>
              ) : null}
            </>
          ) : (
            <>
              <FilterField
                label="Search public channels"
                value={query}
                onChange={(value) => {
                  setQuery(value.slice(0, 64));
                }}
              />
              {!found && !error ? <LoadingCards label="Searching" /> : null}
              {found?.length === 0 ? (
                <EmptyState icon="compass" title="No channels found">
                  {query ? 'Try a different name or @handle.' : 'There are no public channels yet.'}
                </EmptyState>
              ) : null}
              {found?.length ? (
                <CardGrid label="Public channels">
                  {found.map((channel) => (
                    <ChannelCard key={channel.id} channel={channel} />
                  ))}
                </CardGrid>
              ) : null}
              {cursor ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    channelsApi.discover(query, cursor).then(
                      (page) => {
                        setFound((current) => [...(current ?? []), ...page.items]);
                        setCursor(page.nextCursor);
                      },
                      () => {
                        setError('More channels could not be loaded.');
                      },
                    );
                  }}
                >
                  Load more
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
      {creating ? (
        <CreateChannelDialog
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(channel) => {
            setCreating(false);
            void navigate(`/channels/${channel.id}`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
