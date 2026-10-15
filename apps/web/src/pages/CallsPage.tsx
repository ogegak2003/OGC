import { callDescription, conversationTitle, isMissedCall } from '@ogc/messaging';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { CallButtons } from '../components/calls/CallButtons';
import { Icon } from '../components/Icon';
import { Alert, Skeleton } from '../components/ui';
import { listTime } from '../messaging/format';
import { useRecentCalls } from '../messaging/hooks';
import { useMessaging } from '../messaging/messaging-context';
import styles from './CallsPage.module.css';

/** `/calls`: recent calls (with call-back) and the people you can call. */
export function CallsPage() {
  const { conversations, presence, watchPresence, status } = useMessaging();
  const { calls, failed } = useRecentCalls();
  const callable = useMemo(
    () => conversations.filter((c) => c.peer !== null && !c.blockedByMe),
    [conversations],
  );
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  useEffect(() => {
    const ogcIds = callable.flatMap((c) => (c.peer ? [c.peer.ogcId] : []));
    if (ogcIds.length > 0) watchPresence(ogcIds.slice(0, 100));
  }, [callable, watchPresence]);

  return (
    <AppShell title="Calls">
      <p className={styles.intro}>
        One-to-one voice and video calls with the people you chat with.
      </p>

      <section className={styles.section} aria-labelledby="recent-calls">
        <h2 id="recent-calls" className={styles.heading}>
          Recent calls
        </h2>
        {failed ? (
          <Alert>Your call history could not be loaded.</Alert>
        ) : calls === undefined ? (
          <div className={styles.surface} role="status" aria-label="Loading your calls">
            {[0, 1, 2].map((key) => (
              <div key={key} className={styles.row}>
                <Skeleton width="2.75rem" height="2.75rem" round />
                <Skeleton width="50%" />
              </div>
            ))}
          </div>
        ) : calls.length === 0 ? (
          <div className={[styles.surface, styles.empty].join(' ')}>
            <Icon name="phone" size={24} />
            <p>No calls yet. Start one below or from a chat.</p>
          </div>
        ) : (
          <ul className={styles.surface}>
            {calls.map((call) => {
              const conversation = byId.get(call.conversationId);
              const name = call.peer.displayName || formatOgcIdForDisplay(call.peer.ogcId);
              return (
                <li key={call.id} className={styles.row}>
                  <Avatar url={call.peer.avatarUrl} name={name} size={44} />
                  <Link to={`/messages/${call.conversationId}`} className={styles.text}>
                    <span className={styles.name}>{name}</span>
                    <span className={isMissedCall(call) ? styles.missed : styles.detail}>
                      <Icon name={call.media === 'VIDEO' ? 'video' : 'phone'} size={14} />
                      {callDescription(call)}
                    </span>
                  </Link>
                  <span className={styles.time}>{listTime(call.createdAt)}</span>
                  {conversation?.peer && !conversation.blockedByMe ? (
                    <CallButtons
                      conversationId={conversation.id}
                      peer={conversation.peer}
                      name={name}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="start-call">
        <h2 id="start-call" className={styles.heading}>
          Start a call
        </h2>
        {status !== 'ready' ? (
          <div className={styles.surface} role="status" aria-label="Loading your conversations">
            <div className={styles.row}>
              <Skeleton width="2.75rem" height="2.75rem" round />
              <Skeleton width="40%" />
            </div>
          </div>
        ) : callable.length === 0 ? (
          <div className={[styles.surface, styles.empty].join(' ')}>
            <Icon name="contacts" size={24} />
            <p>
              Calls are with people you chat with. <Link to="/discover">Find someone</Link> by their
              OGC ID and start a conversation first.
            </p>
          </div>
        ) : (
          <ul className={styles.surface}>
            {callable.map((conversation) => {
              const peer = conversation.peer;
              if (!peer) return null;
              const name = conversationTitle(conversation);
              const online = presence[peer.ogcId] === 'ONLINE';
              return (
                <li key={conversation.id} className={styles.row}>
                  <span className={styles.avatar}>
                    <Avatar url={peer.avatarUrl} name={name} size={44} />
                    {online ? <span className={styles.online} title="Online" /> : null}
                  </span>
                  <Link to={`/messages/${conversation.id}`} className={styles.text}>
                    <span className={styles.name}>{name}</span>
                    <span className={styles.detail}>{online ? 'Online' : 'Not online now'}</span>
                  </Link>
                  <CallButtons conversationId={conversation.id} peer={peer} name={name} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
