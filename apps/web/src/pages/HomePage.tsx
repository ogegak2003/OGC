import { callDescription, conversationTitle, isMissedCall } from '@ogc/messaging';
import type { CallView, ConversationView, OwnProfile } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { CallButtons } from '../components/calls/CallButtons';
import { BarChart } from '../components/charts/BarChart';
import { CreateGroupDialog } from '../components/groups/CreateGroupDialog';
import { Icon, type IconName } from '../components/Icon';
import { IdentityCard } from '../components/IdentityCard';
import { ConversationRow } from '../components/messaging/ConversationList';
import { NewConversationDialog } from '../components/messaging/Dialogs';
import list from '../components/messaging/messaging.module.css';
import { Alert, Button, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { callsByDay, missedSince, talkMinutes } from '../lib/activity';
import { errorMessage } from '../lib/form';
import { useResource } from '../lib/use-resource';
import { listTime } from '../messaging/format';
import { useRecentCalls } from '../messaging/hooks';
import { useMessaging } from '../messaging/messaging-context';
import styles from './HomePage.module.css';

/** Activity entries shown on the dashboard (conversations and calls together). */
const ACTIVITY = 6;
/** People watched for "Online now" (direct-conversation peers; presence is limited to them). */
const PRESENCE_WATCH = 50;
/** Days in the calls chart. */
const CHART_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** What the profile is missing, from the profile itself (the display name is always set). */
function missingParts(profile: OwnProfile): string[] {
  const missing: string[] = [];
  if (!profile.avatarUrl) missing.push('Add a profile photo');
  if (!profile.bio?.trim()) missing.push('Write a short bio');
  return missing;
}

function QuickAction({
  icon,
  label,
  hint,
  to,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint: string;
  to?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className={styles.quickIcon}>
        <Icon name={icon} size={20} />
      </span>
      <span className={styles.quickText}>
        <span className={styles.quickLabel}>{label}</span>
        <span className={styles.quickHint}>{hint}</span>
      </span>
    </>
  );
  return to ? (
    <Link to={to} className={styles.quick}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={styles.quick} onClick={onClick}>
      {inner}
    </button>
  );
}

/** One real number with a link to where it comes from. `value` undefined = still loading. */
function Stat({
  icon,
  label,
  value,
  to,
  tone = 'default',
}: {
  icon: IconName;
  label: string;
  value: number | string | undefined;
  to: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <Link
      to={to}
      className={[styles.stat, tone === 'attention' ? styles.statAttention : ''].join(' ')}
    >
      <span className={styles.statIcon}>
        <Icon name={icon} size={18} />
      </span>
      <span className={styles.statValue}>{value ?? <Skeleton width="2rem" height="1.5rem" />}</span>
      <span className={styles.statLabel}>{label}</span>
    </Link>
  );
}

/** A call in the activity feed, laid out like a conversation row. */
function CallActivityRow({ call }: { call: CallView }) {
  const name = call.peer.displayName || formatOgcIdForDisplay(call.peer.ogcId);
  const missed = isMissedCall(call);
  return (
    <li>
      <Link to={`/messages/${call.conversationId}`} className={list.row}>
        <span className={list.avatarWrap}>
          <span className={missed ? styles.callIconMissed : styles.callIcon}>
            <Icon name={call.media === 'VIDEO' ? 'video' : 'phone'} size={20} />
          </span>
        </span>
        <span className={list.rowBody}>
          <span className={list.rowTop}>
            <span className={list.rowName}>{name}</span>
            <span className={list.rowTime}>{listTime(call.createdAt)}</span>
          </span>
          <span className={list.rowBottom}>
            <span className={missed ? styles.missedText : list.rowPreview}>
              {callDescription(call)}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

type Activity =
  | { kind: 'conversation'; at: string; conversation: ConversationView }
  | { kind: 'call'; at: string; call: CallView };

/** Latest conversations and calls, newest first — all real data from this account. */
function ActivityFeed({
  calls,
  onNewConversation,
}: {
  calls: CallView[] | undefined;
  onNewConversation: () => void;
}) {
  const { conversations, status, error, retry } = useMessaging();
  const items = useMemo<Activity[]>(() => {
    const merged: Activity[] = [
      ...conversations.slice(0, ACTIVITY).map((conversation) => ({
        kind: 'conversation' as const,
        at: conversation.lastActivityAt,
        conversation,
      })),
      ...(calls ?? [])
        .slice(0, ACTIVITY)
        .map((call) => ({ kind: 'call' as const, at: call.createdAt, call })),
    ];
    return merged.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY);
  }, [conversations, calls]);

  return (
    <section className={styles.card} aria-labelledby="activity-heading">
      <div className={styles.cardHeader}>
        <h2 id="activity-heading" className={styles.cardTitle}>
          Recent activity
        </h2>
        {conversations.length > 0 ? (
          <Link to="/messages" className={styles.seeAll}>
            All messages
            <Icon name="arrowRight" size={16} />
          </Link>
        ) : null}
      </div>
      {status === 'error' ? (
        <Alert>
          Secure messaging could not start on this device. {error}{' '}
          <button type="button" className={styles.inlineButton} onClick={retry}>
            Retry
          </button>
        </Alert>
      ) : status !== 'ready' ? (
        <div role="status" aria-label="Loading your conversations">
          {[0, 1, 2].map((key) => (
            <div key={key} className={styles.skeletonRow}>
              <Skeleton width="2.75rem" height="2.75rem" round />
              <span className={styles.skeletonLines}>
                <Skeleton width="40%" />
                <Skeleton width="70%" height="0.75rem" />
              </span>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Icon name="chat" size={22} />
          </span>
          <p className={styles.emptyTitle}>No conversations yet</p>
          <p className={styles.muted}>
            Add a contact by their OGC ID, then start an end-to-end encrypted chat.
          </p>
          <Button variant="secondary" onClick={onNewConversation}>
            Start a conversation
          </Button>
        </div>
      ) : (
        <ul className={styles.rows} aria-label="Recent conversations and calls">
          {items.map((item) =>
            item.kind === 'conversation' ? (
              <ConversationRow
                key={`c-${item.conversation.id}`}
                conversation={item.conversation}
                active={false}
              />
            ) : (
              <CallActivityRow key={`k-${item.call.id}`} call={item.call} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** Calls over the last two weeks, from this account's call history. */
function CallsChart({ calls, failed }: { calls: CallView[] | undefined; failed: boolean }) {
  const points = useMemo(() => (calls ? callsByDay(calls, CHART_DAYS) : []), [calls]);
  const total = points.reduce(
    (sum, point) => sum + Object.values(point.values).reduce((a, b) => a + b, 0),
    0,
  );
  return (
    <section className={styles.card} aria-labelledby="calls-chart-heading">
      <div className={styles.cardHeader}>
        <h2 id="calls-chart-heading" className={styles.cardTitle}>
          Calls, last {CHART_DAYS} days
        </h2>
        <Link to="/calls" className={styles.seeAll}>
          Call history
          <Icon name="arrowRight" size={16} />
        </Link>
      </div>
      {failed ? (
        <p className={styles.muted}>Call history could not be loaded right now.</p>
      ) : !calls ? (
        <div role="status" aria-label="Loading call activity">
          <Skeleton height="10rem" />
        </div>
      ) : total === 0 ? (
        <div className={styles.chartEmpty}>
          <Icon name="barChart" size={22} />
          <p className={styles.muted}>
            No calls in the last {CHART_DAYS} days. Voice and video calls you make or receive will
            appear here.
          </p>
        </div>
      ) : (
        <>
          <BarChart
            title={`Calls per day, last ${String(CHART_DAYS)} days`}
            unit="calls"
            points={points}
            series={[
              { key: 'answered', label: 'Answered', color: 'var(--ogc-color-accent)' },
              { key: 'missed', label: 'Missed', color: 'var(--ogc-color-danger)' },
              { key: 'other', label: 'Not connected', color: 'var(--ogc-color-chart-secondary)' },
            ]}
          />
          <p className={styles.chartNote}>
            From your most recent call history. Talk time: {talkMinutes(calls)} min.
          </p>
        </>
      )}
    </section>
  );
}

/** People you chat with who are online right now (presence is shared only between them). */
function OnlineNow() {
  const { conversations, presence, watchPresence, status } = useMessaging();
  const direct = useMemo(
    () => conversations.filter((c) => c.peer !== null && !c.blockedByMe).slice(0, PRESENCE_WATCH),
    [conversations],
  );
  useEffect(() => {
    const ogcIds = direct.flatMap((c) => (c.peer ? [c.peer.ogcId] : []));
    if (ogcIds.length > 0) watchPresence(ogcIds);
  }, [direct, watchPresence]);
  const online = direct.filter((c) => c.peer && presence[c.peer.ogcId] === 'ONLINE');

  return (
    <section className={styles.card} aria-labelledby="online-heading">
      <div className={styles.cardHeader}>
        <h2 id="online-heading" className={styles.cardTitle}>
          <span className={styles.liveDot} aria-hidden="true" />
          Online now
        </h2>
        {status === 'ready' ? <span className={styles.count}>{online.length}</span> : null}
      </div>
      {status !== 'ready' ? (
        <p className={styles.muted}>Checking who is online…</p>
      ) : online.length === 0 ? (
        <p className={styles.muted}>
          {direct.length === 0
            ? 'People you chat with appear here when they are online.'
            : 'Nobody you chat with is online right now.'}
        </p>
      ) : (
        <ul className={styles.people}>
          {online.map((conversation) => {
            const peer = conversation.peer;
            if (!peer) return null;
            const name = conversationTitle(conversation);
            return (
              <li key={conversation.id} className={styles.person}>
                <Link to={`/messages/${conversation.id}`} className={styles.personLink}>
                  <span className={styles.personAvatar}>
                    <Avatar url={peer.avatarUrl} name={name} size={36} />
                    <span className={styles.personDot} aria-hidden="true" />
                  </span>
                  <span className={styles.personText}>
                    <span className={styles.personName}>{name}</span>
                    <span className={styles.personState}>Online</span>
                  </span>
                </Link>
                <CallButtons conversationId={conversation.id} peer={peer} name={name} />
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/contacts" className={styles.seeAll}>
        All contacts
        <Icon name="arrowRight" size={14} />
      </Link>
    </section>
  );
}

/**
 * The signed-in dashboard: a welcome with the person's real name, numbers that link to their
 * source (unread messages, missed calls, contact requests, notifications), quick actions,
 * recent activity, a calls chart from real call history, who is online, and the OGC identity
 * card. Nothing on this page is placeholder data.
 */
export function HomePage() {
  const navigate = useNavigate();
  const { unreadTotal, notificationsUnread, status } = useMessaging();
  const { calls, failed } = useRecentCalls();
  const load = useCallback((signal: AbortSignal) => api.profile(signal), []);
  const { state } = useResource(load);
  const loadRequests = useCallback(
    (signal: AbortSignal) => api.incomingRequests(undefined, signal),
    [],
  );
  const { state: requests } = useResource(loadRequests);
  const [dialog, setDialog] = useState<'conversation' | 'group'>();
  // Fixed when the page opens; the window moves on the next visit.
  const [weekAgo] = useState(() => new Date(Date.now() - 7 * DAY_MS));

  if (state.status === 'loading') {
    return (
      <AppShell title="Home" hideTitle width="wide">
        <div className={styles.welcome} role="status" aria-label="Loading your profile">
          <Skeleton width="30%" height="1rem" />
          <Skeleton width="45%" height="2rem" />
        </div>
      </AppShell>
    );
  }
  if (state.status === 'error') {
    return (
      <AppShell title="Home">
        <Alert>{errorMessage(state.error)}</Alert>
      </AppShell>
    );
  }
  const profile = state.data;
  const missing = missingParts(profile);
  const openConversation = () => {
    setDialog('conversation');
  };
  const missed = calls ? missedSince(calls, weekAgo) : failed ? '—' : undefined;
  const requestCount =
    requests.status === 'ready'
      ? `${String(requests.data.items.length)}${requests.data.nextCursor ? '+' : ''}`
      : requests.status === 'error'
        ? '—'
        : undefined;

  return (
    <AppShell title="Home" hideTitle width="wide">
      <section className={styles.welcome} aria-labelledby="welcome-heading">
        <div className={styles.welcomeText}>
          <p className={styles.welcomeLead}>{greeting()}</p>
          <h2 id="welcome-heading" className={styles.welcomeName}>
            {profile.displayName}
          </h2>
          <p className={styles.welcomeMeta}>
            <Icon name="lock" size={14} />
            Messages and group chats are end-to-end encrypted on your devices.
          </p>
        </div>
        <div className={styles.welcomeActions}>
          <Button icon="chat" onClick={openConversation}>
            Start a conversation
          </Button>
          <Link to="/discover" className={styles.secondaryLink}>
            <Icon name="userPlus" size={18} />
            Find by OGC ID
          </Link>
        </div>
      </section>

      <section className={styles.stats} aria-label="At a glance">
        <Stat
          icon="chat"
          label="Unread messages"
          value={status === 'ready' ? unreadTotal : undefined}
          to="/messages"
          tone={unreadTotal > 0 ? 'attention' : 'default'}
        />
        <Stat
          icon="phoneOff"
          label="Missed calls, 7 days"
          value={missed}
          to="/calls"
          tone={typeof missed === 'number' && missed > 0 ? 'attention' : 'default'}
        />
        <Stat icon="userPlus" label="Contact requests" value={requestCount} to="/contacts" />
        <Stat
          icon="bell"
          label="New notifications"
          value={status === 'ready' ? notificationsUnread : undefined}
          to="/notifications"
        />
      </section>

      <div className={styles.dashboard}>
        <div className={styles.center}>
          <section aria-labelledby="quick-heading">
            <h2 id="quick-heading" className={styles.visuallyHidden}>
              Quick actions
            </h2>
            <div className={styles.quickGrid}>
              <QuickAction
                icon="chat"
                label="New message"
                hint="Message a contact"
                onClick={openConversation}
              />
              <QuickAction icon="phone" label="Start call" hint="Voice or video" to="/calls" />
              <QuickAction
                icon="community"
                label="New group"
                hint="Encrypted, up to 32"
                onClick={() => {
                  setDialog('group');
                }}
              />
              <QuickAction
                icon="compass"
                label="Explore channels"
                hint="Public communities"
                to="/channels"
              />
            </div>
          </section>

          <ActivityFeed calls={calls} onNewConversation={openConversation} />
          <CallsChart calls={calls} failed={failed} />
        </div>

        <aside className={styles.rail} aria-label="People and identity">
          <IdentityCard profile={profile} />
          {missing.length > 0 ? (
            <Link to="/profile/edit" className={styles.progress}>
              <span className={styles.progressTop}>
                <span className={styles.progressTitle}>Complete your profile</span>
                <span className={styles.progressCount}>{3 - missing.length}/3</span>
              </span>
              <span className={styles.track} aria-hidden="true">
                <span
                  className={styles.fill}
                  style={{ width: `${String(((3 - missing.length) / 3) * 100)}%` }}
                />
              </span>
              <span className={styles.muted}>{missing.join(' · ')}</span>
            </Link>
          ) : null}
          <OnlineNow />
        </aside>
      </div>

      {dialog === 'conversation' ? (
        <NewConversationDialog
          onClose={() => {
            setDialog(undefined);
          }}
          onOpened={(opened) => {
            setDialog(undefined);
            void navigate(`/messages/${opened.id}`);
          }}
        />
      ) : null}
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
    </AppShell>
  );
}
