import { isMissedCall } from '@ogc/messaging';
import type { NotificationType, NotificationView } from '@ogc/types';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState, LinkButton, PageIntro, SegmentedTabs } from '../components/kit';
import { tabId, tabPanelId } from '../components/kit-ids';
import { Alert, Button, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { notificationsApi } from '../lib/community-api';
import { describeNotification } from '../lib/notifications';
import { listTime } from '../messaging/format';
import { useRecentCalls } from '../messaging/hooks';
import { useMessaging } from '../messaging/messaging-context';
import styles from './NotificationsPage.module.css';

type Category = 'all' | 'groups' | 'channels';

const GROUP_TYPES: ReadonlySet<NotificationType> = new Set([
  'GROUP_INVITATION',
  'GROUP_MEMBER_ADDED',
  'GROUP_MEMBER_REMOVED',
  'GROUP_ROLE_CHANGED',
  'GROUP_DETAILS_CHANGED',
  'INVITATION_EXPIRED',
]);

/** Groups and their invitations, or channels; a mention belongs to whichever it came from. */
function categoryOf(n: NotificationView): Exclude<Category, 'all'> {
  if (n.type === 'MENTION')
    return typeof n.data.conversationId === 'string' ? 'groups' : 'channels';
  return GROUP_TYPES.has(n.type) ? 'groups' : 'channels';
}

function iconOf(n: NotificationView): IconName {
  switch (n.type) {
    case 'GROUP_INVITATION':
    case 'INVITATION_EXPIRED':
      return 'mail';
    case 'MENTION':
      return 'at';
    case 'CHANNEL_ANNOUNCEMENT':
      return 'megaphone';
    case 'MODERATION_RESULT':
    case 'CHANNEL_MEMBER_REMOVED':
      return 'shield';
    case 'CHANNEL_JOIN_REQUEST':
      return 'userPlus';
    default:
      return categoryOf(n) === 'groups' ? 'community' : 'hash';
  }
}

/** "Today", "Yesterday" or the date, for grouping the list by day. */
function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** Contact requests waiting for an answer, counted from the server (0 when it can’t be read). */
function usePendingRequests(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.incomingRequests(undefined, controller.signal).then(
      (page) => {
        setCount(page.items.length);
      },
      () => undefined,
    );
    return () => {
      controller.abort();
    };
  }, []);
  return count;
}

/**
 * `/notifications`: group and channel activity, newest first and grouped by day, plus what is
 * waiting elsewhere (contact requests, missed calls). Opening the page marks everything read, as
 * the service supports; items that were new are still marked "New" until you leave.
 */
export function NotificationsPage() {
  const { setNotificationsUnread } = useMessaging();
  const [items, setItems] = useState<NotificationView[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [category, setCategory] = useState<Category>('all');
  const pendingRequests = usePendingRequests();
  const { calls } = useRecentCalls();
  const missedCalls = calls?.filter(isMissedCall).length ?? 0;

  useEffect(() => {
    const controller = new AbortController();
    notificationsApi.list(undefined, controller.signal).then(
      (page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
        if (page.unread > 0) {
          void notificationsApi.markRead({ all: true }).then(() => {
            setNotificationsUnread(0);
          });
        }
      },
      () => {
        if (!controller.signal.aborted) setError('Notifications could not be loaded.');
      },
    );
    return () => {
      controller.abort();
    };
  }, [setNotificationsUnread]);

  const days = useMemo(() => {
    const now = new Date();
    const shown = (items ?? []).filter((n) => category === 'all' || categoryOf(n) === category);
    const grouped = new Map<string, NotificationView[]>();
    for (const n of shown) {
      const label = dayLabel(n.createdAt, now);
      grouped.set(label, [...(grouped.get(label) ?? []), n]);
    }
    return [...grouped.entries()];
  }, [items, category]);

  const count = (c: Exclude<Category, 'all'>) =>
    items?.filter((n) => !n.readAt && categoryOf(n) === c).length ?? 0;

  return (
    <AppShell title="Notifications">
      <div className={styles.page}>
        <PageIntro
          actions={
            <LinkButton to="/settings/notifications" icon="settings">
              Notification settings
            </LinkButton>
          }
        >
          Group and channel activity. Notifications never include message text.
        </PageIntro>

        {pendingRequests > 0 || missedCalls > 0 ? (
          <section className={styles.waiting} aria-label="Waiting for you">
            {pendingRequests > 0 ? (
              <Link to="/contacts?tab=requests" className={styles.waitingCard}>
                <span className={styles.waitingIcon}>
                  <Icon name="userPlus" size={18} />
                </span>
                <span className={styles.waitingText}>
                  <span className={styles.waitingTitle}>
                    {pendingRequests} contact {pendingRequests === 1 ? 'request' : 'requests'}
                  </span>
                  <span className={styles.waitingDetail}>Waiting for your answer</span>
                </span>
                <Icon name="chevronRight" size={16} />
              </Link>
            ) : null}
            {missedCalls > 0 ? (
              <Link to="/calls" className={styles.waitingCard}>
                <span className={[styles.waitingIcon, styles.waitingMissed].join(' ')}>
                  <Icon name="phoneOff" size={18} />
                </span>
                <span className={styles.waitingText}>
                  <span className={styles.waitingTitle}>
                    {missedCalls} missed {missedCalls === 1 ? 'call' : 'calls'}
                  </span>
                  <span className={styles.waitingDetail}>In your recent calls</span>
                </span>
                <Icon name="chevronRight" size={16} />
              </Link>
            ) : null}
          </section>
        ) : null}

        {items?.length ? (
          <SegmentedTabs
            label="Notification categories"
            prefix="notifications"
            value={category}
            onChange={setCategory}
            options={[
              { id: 'all', label: 'All' },
              { id: 'groups', label: 'Groups', count: count('groups'), countLabel: 'new' },
              { id: 'channels', label: 'Channels', count: count('channels'), countLabel: 'new' },
            ]}
          />
        ) : null}

        {error ? <Alert>{error}</Alert> : null}
        {!items && !error ? (
          <div className={styles.list} role="status" aria-label="Loading notifications">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} height="3.75rem" />
            ))}
          </div>
        ) : null}
        {items?.length === 0 ? (
          <EmptyState icon="bell" title="You’re all caught up.">
            Group invitations, mentions and channel announcements appear here.
          </EmptyState>
        ) : null}
        {items?.length && days.length === 0 ? (
          <EmptyState icon="bell" title="Nothing in this category." />
        ) : null}

        {items?.length ? (
          <div
            role="tabpanel"
            id={tabPanelId('notifications', category)}
            aria-labelledby={tabId('notifications', category)}
            className={styles.days}
          >
            {days.map(([label, list]) => (
              <section key={label} className={styles.day} aria-label={label}>
                <h2 className={styles.dayLabel}>{label}</h2>
                <ul className={styles.list}>
                  {list.map((n) => {
                    const { line, to } = describeNotification(n);
                    const body = (
                      <>
                        <span
                          className={[
                            styles.icon,
                            categoryOf(n) === 'groups' ? styles.iconGroup : styles.iconChannel,
                          ].join(' ')}
                          aria-hidden="true"
                        >
                          <Icon name={iconOf(n)} size={18} />
                        </span>
                        <span className={styles.text}>
                          <span className={styles.line}>{line}</span>
                          <time className={styles.time} dateTime={n.createdAt}>
                            {listTime(n.createdAt)}
                          </time>
                        </span>
                        {n.readAt ? null : <span className={styles.new}>New</span>}
                      </>
                    );
                    return (
                      <li key={n.id} className={n.readAt ? styles.item : styles.itemUnread}>
                        {to ? (
                          <Link to={to} className={styles.row} aria-label={line}>
                            {body}
                          </Link>
                        ) : (
                          <div className={styles.row}>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : null}

        {cursor ? (
          <Button
            variant="secondary"
            onClick={() => {
              notificationsApi.list(cursor).then(
                (page) => {
                  setItems((current) => [...(current ?? []), ...page.items]);
                  setCursor(page.nextCursor);
                },
                () => {
                  setError('More notifications could not be loaded.');
                },
              );
            }}
          >
            Load more
          </Button>
        ) : null}
      </div>
    </AppShell>
  );
}
