import type { NotificationView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '../components/AppShell';
import styles from '../components/messaging/messaging.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { notificationsApi } from '../lib/community-api';
import { describeNotification } from '../lib/notifications';
import { useMessaging } from '../messaging/messaging-context';

/** `/notifications`: in-app notifications, newest first. */
export function NotificationsPage() {
  const { setNotificationsUnread } = useMessaging();
  const [items, setItems] = useState<NotificationView[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();

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

  return (
    <AppShell title="Notifications">
      {error ? <Alert>{error}</Alert> : null}
      {!items && !error ? <Spinner label="Loading notifications" /> : null}
      {items?.length === 0 ? <p className={styles.sidebarNote}>You’re all caught up.</p> : null}
      <ul className={styles.cardList}>
        {items?.map((n) => {
          const { line, to } = describeNotification(n);
          return (
            <li key={n.id} className={[styles.card, n.readAt ? '' : styles.cardUnread].join(' ')}>
              <div className={styles.cardBody}>
                {to ? (
                  <Link to={to} className={styles.cardLink}>
                    {line}
                  </Link>
                ) : (
                  <span>{line}</span>
                )}
                <time className={styles.sidebarNote} dateTime={n.createdAt}>
                  {new Date(n.createdAt).toLocaleString()}
                </time>
              </div>
            </li>
          );
        })}
      </ul>
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
    </AppShell>
  );
}
