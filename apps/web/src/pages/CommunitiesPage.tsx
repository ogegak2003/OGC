import type { ChannelView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppShell } from '../components/AppShell';
import { CreateChannelDialog } from '../components/channels/CreateChannelDialog';
import { CreateGroupDialog } from '../components/groups/CreateGroupDialog';
import { Icon } from '../components/Icon';
import { ConversationRow } from '../components/messaging/ConversationList';
import messaging from '../components/messaging/messaging.module.css';
import { Alert, Button, Skeleton } from '../components/ui';
import { channelsApi } from '../lib/community-api';
import { useMessaging } from '../messaging/messaging-context';
import { ChannelRow } from './ChannelsPage';
import styles from './CommunitiesPage.module.css';

function LoadingRows({ label }: { label: string }) {
  return (
    <div className={styles.surface} role="status" aria-label={label}>
      {[0, 1].map((key) => (
        <div key={key} className={styles.skeletonRow}>
          <Skeleton width="2.75rem" height="2.75rem" round />
          <span className={styles.skeletonLines}>
            <Skeleton width="35%" />
            <Skeleton width="60%" height="0.75rem" />
          </span>
        </div>
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
      <p className={styles.lead}>Private groups and open channels.</p>
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

      <section className={styles.section} aria-labelledby="groups-heading">
        <h2 id="groups-heading" className={styles.sectionTitle}>
          Groups
        </h2>
        {status !== 'ready' && status !== 'error' ? (
          <LoadingRows label="Loading groups" />
        ) : groups.length === 0 ? (
          <div className={[styles.surface, styles.empty].join(' ')}>
            <span className={styles.emptyIcon}>
              <Icon name="community" size={24} />
            </span>
            <p className={styles.emptyTitle}>No groups yet</p>
            <p className={styles.muted}>
              Groups are end-to-end encrypted for their members’ devices.
            </p>
            <Button
              variant="secondary"
              icon="plus"
              onClick={() => {
                setDialog('group');
              }}
            >
              Create a group
            </Button>
          </div>
        ) : (
          <ul className={[styles.surface, styles.rows].join(' ')}>
            {groups.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} active={false} />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="channels-heading">
        <div className={styles.sectionHeader}>
          <h2 id="channels-heading" className={styles.sectionTitle}>
            Channels
          </h2>
          <Link to="/channels" className={styles.sectionLink}>
            Explore channels
          </Link>
        </div>
        <p className={styles.note}>
          <Icon name="globe" size={14} />
          Channels are not end-to-end encrypted: OGC can read posts for moderation and search.
        </p>
        {error ? <Alert>{error}</Alert> : null}
        {!channels && !error ? <LoadingRows label="Loading channels" /> : null}
        {channels?.length === 0 ? (
          <div className={[styles.surface, styles.empty].join(' ')}>
            <span className={styles.emptyIcon}>
              <Icon name="hash" size={24} />
            </span>
            <p className={styles.emptyTitle}>No channels yet</p>
            <p className={styles.muted}>
              Follow channels for announcements and discussions from larger communities.
            </p>
          </div>
        ) : null}
        {channels?.length ? (
          <ul className={messaging.cardList}>
            {channels.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </ul>
        ) : null}
      </section>

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
