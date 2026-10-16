import type { ChannelView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppShell } from '../components/AppShell';
import { CreateChannelDialog } from '../components/channels/CreateChannelDialog';
import { CardGrid, ChannelCard, GroupCard } from '../components/community/CommunityCards';
import community from '../components/community/community.module.css';
import { CreateGroupDialog } from '../components/groups/CreateGroupDialog';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/kit';
import { Alert, Button, Skeleton } from '../components/ui';
import { channelsApi } from '../lib/community-api';
import { useMessaging } from '../messaging/messaging-context';
import styles from './CommunitiesPage.module.css';

function LoadingCards({ label }: { label: string }) {
  return (
    <div className={community.grid} role="status" aria-label={label}>
      {[0, 1].map((key) => (
        <Skeleton key={key} height="6.5rem" />
      ))}
    </div>
  );
}

/**
 * `/communities`: groups (end-to-end encrypted conversations) and community
 * channels (open, moderated feeds — not end-to-end encrypted) in one place.
 */
export function CommunitiesPage() {
  const navigate = useNavigate();
  const { conversations, status } = useMessaging();
  const [channels, setChannels] = useState<ChannelView[]>();
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<'group' | 'channel'>();
  const groups = conversations.filter((c) => c.group !== null);

  useEffect(() => {
    const controller = new AbortController();
    channelsApi.mine(controller.signal).then(setChannels, () => {
      if (!controller.signal.aborted) setError('Your channels could not be loaded.');
    });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <AppShell title="Communities">
      <div className={community.page}>
        <div className={community.kinds}>
          <div className={community.kind}>
            <span className={[community.kindIcon, community.kindIconGroup].join(' ')}>
              <Icon name="lock" size={20} />
            </span>
            <span className={community.kindText}>
              <span className={community.kindTitle}>Groups are private</span>
              <span className={community.kindDetail}>
                Invite-only conversations, end-to-end encrypted for members’ devices. OGC cannot
                read them.
              </span>
            </span>
          </div>
          <div className={community.kind}>
            <span className={[community.kindIcon, community.kindIconChannel].join(' ')}>
              <Icon name="megaphone" size={20} />
            </span>
            <span className={community.kindText}>
              <span className={community.kindTitle}>Channels are communities</span>
              <span className={community.kindDetail}>
                Open, moderated feeds for larger audiences. Not end-to-end encrypted: OGC can read
                posts for moderation and search.
              </span>
            </span>
          </div>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              setDialog('group');
            }}
          >
            <Icon name="community" />
            New group
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              setDialog('channel');
            }}
          >
            <Icon name="megaphone" />
            New channel
          </button>
          <Link to="/invitations" className={styles.action}>
            <Icon name="inbox" />
            Invitations
          </Link>
          <Link to="/join" className={styles.action}>
            <Icon name="link" />
            Join with a link
          </Link>
        </div>

        <section className={community.section} aria-labelledby="groups-heading">
          <h2 id="groups-heading" className={styles.sectionTitle}>
            Groups
          </h2>
          {status !== 'ready' && status !== 'error' ? (
            <LoadingCards label="Loading groups" />
          ) : groups.length === 0 ? (
            <EmptyState
              icon="lock"
              title="No groups yet"
              action={
                <Button
                  variant="secondary"
                  icon="plus"
                  onClick={() => {
                    setDialog('group');
                  }}
                >
                  Create a group
                </Button>
              }
            >
              Groups are end-to-end encrypted for their members’ devices.
            </EmptyState>
          ) : (
            <CardGrid label="Your groups">
              {groups.map((conversation) => (
                <GroupCard key={conversation.id} conversation={conversation} />
              ))}
            </CardGrid>
          )}
        </section>

        <section className={community.section} aria-labelledby="channels-heading">
          <div className={styles.sectionHeader}>
            <h2 id="channels-heading" className={styles.sectionTitle}>
              Channels
            </h2>
            <Link to="/channels" className={styles.sectionLink}>
              Explore channels
            </Link>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          {!channels && !error ? <LoadingCards label="Loading channels" /> : null}
          {channels?.length === 0 ? (
            <EmptyState
              icon="megaphone"
              title="No channels yet"
              action={
                <Link to="/channels" className={styles.sectionLink}>
                  Discover channels
                </Link>
              }
            >
              Follow channels for announcements and discussions from larger communities.
            </EmptyState>
          ) : null}
          {channels?.length ? (
            <CardGrid label="Your channels">
              {channels.map((channel) => (
                <ChannelCard key={channel.id} channel={channel} />
              ))}
            </CardGrid>
          ) : null}
        </section>
      </div>

      {dialog === 'group' ? (
        <CreateGroupDialog
          onClose={() => {
            setDialog(undefined);
          }}
          onCreated={(created) => {
            setDialog(undefined);
            void navigate(`/messages/${created.id}`);
          }}
        />
      ) : null}
      {dialog === 'channel' ? (
        <CreateChannelDialog
          onClose={() => {
            setDialog(undefined);
          }}
          onCreated={(channel) => {
            setDialog(undefined);
            void navigate(`/channels/${channel.id}`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
