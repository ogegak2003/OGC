import type { ChannelView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { CreateChannelDialog } from '../components/channels/CreateChannelDialog';
import styles from '../components/messaging/messaging.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { channelsApi } from '../lib/community-api';

export function ChannelRow({ channel }: { channel: ChannelView }) {
  return (
    <li className={styles.card}>
      <Avatar url={channel.avatarUrl} name={channel.name} size={48} />
      <div className={styles.cardBody}>
        <Link to={`/channels/${channel.id}`} className={styles.cardLink}>
          {channel.name}
        </Link>
        <p className={styles.sidebarNote}>
          @{channel.handle} · {channel.memberCount}{' '}
          {channel.memberCount === 1 ? 'member' : 'members'}
          {channel.visibility === 'PRIVATE' ? ' · Private' : ''}
          {channel.membership?.status === 'PENDING' ? ' · Request pending' : ''}
        </p>
        {channel.description ? <p className={styles.rowPreview}>{channel.description}</p> : null}
      </div>
      {channel.unreadCount > 0 ? (
        <span className={styles.unread} aria-label={`${String(channel.unreadCount)} unread`}>
          {channel.unreadCount > 999 ? '999+' : channel.unreadCount}
        </span>
      ) : null}
    </li>
  );
}

/** `/channels`: the user's community channels and the public directory with search. */
export function ChannelsPage() {
  const navigate = useNavigate();
  // `?q=` comes from the global search: open the public directory with that search.
  const [params] = useSearchParams();
  const initialQuery = params.get('q') ?? '';
  const [tab, setTab] = useState<'mine' | 'discover'>(initialQuery ? 'discover' : 'mine');
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

  return (
    <AppShell title="Channels">
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="tablist" aria-label="Channels">
          {(['mine', 'discover'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? styles.segmentActive : styles.segment}
              onClick={() => {
                setTab(value);
                setError(undefined);
              }}
            >
              {value === 'mine' ? 'My channels' : 'Discover'}
            </button>
          ))}
        </div>
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          New channel
        </Button>
      </div>
      <p className={styles.sidebarNote}>
        Community channels are open spaces for larger audiences. They are not end-to-end encrypted —
        use groups for private conversations.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {tab === 'mine' ? (
        <>
          {!mine && !error ? <Spinner label="Loading channels" /> : null}
          {mine?.length === 0 ? (
            <p className={styles.sidebarNote}>
              You haven’t joined any channels yet. Find some in Discover.
            </p>
          ) : null}
          <ul className={styles.cardList}>
            {mine?.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </ul>
        </>
      ) : (
        <>
          <input
            type="search"
            className={styles.search}
            placeholder="Search public channels"
            aria-label="Search public channels"
            value={query}
            maxLength={64}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          {!found && !error ? <Spinner label="Searching" /> : null}
          {found?.length === 0 ? <p className={styles.sidebarNote}>No channels found.</p> : null}
          <ul className={styles.cardList}>
            {found?.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </ul>
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
