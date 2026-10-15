import { callDescription, conversationTitle, isMissedCall } from '@ogc/messaging';
import type { CallView, ConversationView, OwnProfile } from '@ogc/types';
import { LOGO_TAGLINE } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import globe from '../assets/welcome-globe.webp';
import { useAuth } from '../auth/auth-context';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { CallButtons } from '../components/calls/CallButtons';
import { CreateGroupDialog } from '../components/groups/CreateGroupDialog';
import { Icon, type IconName } from '../components/Icon';
import { ConversationRow } from '../components/messaging/ConversationList';
import { NewConversationDialog } from '../components/messaging/Dialogs';
import list from '../components/messaging/messaging.module.css';
import { OgcLogo } from '../components/OgcLogo';
import { OgcQrCode } from '../components/OgcQrCode';
import { Alert, Button, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { shareIdentity, shareableIdentity } from '../lib/share';
import { useResource } from '../lib/use-resource';
import { listTime } from '../messaging/format';
import { useRecentCalls } from '../messaging/hooks';
import { useMessaging } from '../messaging/messaging-context';
import styles from './HomePage.module.css';

/** Activity entries shown on the dashboard (conversations and calls together). */
const ACTIVITY = 6;
/** People watched for "Online now" (direct-conversation peers; presence is limited to them). */
const PRESENCE_WATCH = 50;

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
        <Icon name={icon} size={24} />
      </span>
      <span className={styles.quickLabel}>{label}</span>
      <span className={styles.quickHint}>{hint}</span>
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
function ActivityFeed({ onNewConversation }: { onNewConversation: () => void }) {
  const { conversations, status, error, retry } = useMessaging();
  const { calls } = useRecentCalls();
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
          <Icon name="clock" size={20} className={styles.gold} />
          Your activity
        </h2>
        {conversations.length > 0 ? (
          <Link to="/messages" className={styles.seeAll}>
            See all chats
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
            <Icon name="chat" size={24} />
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
                    <Avatar url={peer.avatarUrl} name={name} size={38} />
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
      <Link to="/contacts" className={styles.pillLink}>
        All contacts
        <Icon name="arrowRight" size={14} />
      </Link>
    </section>
  );
}

/** The signed-in dashboard: welcome, quick actions, activity, who is online, and your OGC ID. */
export function HomePage() {
  const { state: auth } = useAuth();
  const navigate = useNavigate();
  const load = useCallback((signal: AbortSignal) => api.profile(signal), []);
  const { state } = useResource(load);
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<'conversation' | 'group'>();
  const [globeFailed, setGlobeFailed] = useState(false);

  if (state.status === 'loading') {
    return (
      <AppShell title="Home" hideTitle width="wide">
        <div className={styles.hero} role="status" aria-label="Loading your profile">
          <div className={styles.heroContent}>
            <Skeleton width="30%" height="1.5rem" />
            <Skeleton width="55%" height="2.5rem" />
            <Skeleton width="70%" height="1rem" />
          </div>
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
  const email = auth.status === 'signed-in' ? auth.account.email : '';
  const missing = missingParts(profile);

  async function share() {
    const result = await shareIdentity(
      shareableIdentity(profile.ogcId, profile.displayName, window.location.origin),
    );
    setNotice(result === 'copied' ? 'Your OGC details were copied to the clipboard.' : undefined);
  }

  async function copyId() {
    await navigator.clipboard.writeText(profile.ogcId);
    setNotice('OGC ID copied.');
  }

  const openConversation = () => {
    setDialog('conversation');
  };

  return (
    <AppShell title="Home" hideTitle width="wide">
      <div className={styles.dashboard}>
        <div className={styles.center}>
          <section className={styles.hero} aria-labelledby="welcome-heading">
            {globeFailed ? null : (
              <img
                className={styles.globe}
                src={globe}
                alt=""
                decoding="async"
                onError={() => {
                  setGlobeFailed(true);
                }}
              />
            )}
            <div className={styles.heroContent}>
              <div className={styles.heroBrand}>
                <OgcLogo height={52} />
                <span className={styles.heroTagline}>{LOGO_TAGLINE}</span>
              </div>
              <h2 id="welcome-heading" className={styles.welcome}>
                <span className={styles.welcomeLead}>{greeting()},</span>
                <span className={styles.welcomeName}>{profile.displayName}</span>
              </h2>
              <p className={styles.heroText}>
                Stay connected with the people who matter — private, end-to-end encrypted
                conversations, groups and calls, anywhere in the world.
              </p>
              <div className={styles.heroActions}>
                <button type="button" className={styles.heroPrimary} onClick={openConversation}>
                  Start a conversation
                  <Icon name="arrowRight" size={18} />
                </button>
                <Link to="/discover" className={styles.heroSecondary}>
                  Find people
                </Link>
              </div>
            </div>
          </section>

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

          <section aria-labelledby="quick-heading">
            <h2 id="quick-heading" className={styles.visuallyHidden}>
              Quick actions
            </h2>
            <div className={styles.quickGrid}>
              <QuickAction
                icon="chat"
                label="New chat"
                hint="Message a contact"
                onClick={openConversation}
              />
              <QuickAction icon="phone" label="Start call" hint="Voice or video" to="/calls" />
              <QuickAction
                icon="community"
                label="Create group"
                hint="Bring people together"
                onClick={() => {
                  setDialog('group');
                }}
              />
              <QuickAction
                icon="megaphone"
                label="Join channel"
                hint="Get updates"
                to="/channels"
              />
              <QuickAction icon="userPlus" label="Find people" hint="By OGC ID" to="/discover" />
            </div>
          </section>

          <ActivityFeed onNewConversation={openConversation} />
        </div>

        <aside className={styles.rail} aria-label="People and identity">
          <OnlineNow />

          <section className={[styles.card, styles.identity].join(' ')} aria-labelledby="ogc-id">
            <div className={styles.identityTop}>
              <span className={styles.identityIcon}>
                <Icon name="globe" size={22} />
              </span>
              <div>
                <h2 id="ogc-id" className={styles.identityTitle}>
                  Your OGC ID
                </h2>
                <p className={styles.identitySub}>One ID. A world of possibilities.</p>
              </div>
            </div>
            <p className={styles.ogcId} aria-label={profile.ogcId}>
              {formatOgcIdForDisplay(profile.ogcId)}
            </p>
            {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
            <div className={styles.qr}>
              <OgcQrCode ogcId={profile.ogcId} size={168} />
            </div>
            <div className={styles.identityActions}>
              <Button
                icon="share"
                onClick={() =>
                  void share().catch((e: unknown) => {
                    setNotice(errorMessage(e));
                  })
                }
              >
                Share my OGC
              </Button>
              <Button icon="copy" variant="secondary" onClick={() => void copyId()}>
                Copy OGC ID
              </Button>
            </div>
            <p className={styles.liveRegion} role="status" aria-live="polite">
              {notice ?? ''}
            </p>
            <dl className={styles.facts}>
              <div>
                <dt>Email</dt>
                <dd>
                  <span className={styles.ellipsis}>{email}</span>
                  <span className={styles.badge}>Private</span>
                </dd>
              </div>
              <div>
                <dt>Profile visible to</dt>
                <dd>
                  {profile.privacy.profileVisibility === 'EVERYONE' ? 'Everyone' : 'Contacts only'}
                </dd>
              </div>
              <div>
                <dt>Findable by OGC ID</dt>
                <dd>{profile.privacy.discoverable ? 'Yes' : 'Only by contacts'}</dd>
              </div>
            </dl>
            <p className={styles.explainer}>
              <Icon name="shieldCheck" size={16} />
              People find you by your OGC ID or QR code. Your email address always stays private.
            </p>
            <Link to="/settings/privacy" className={styles.pillLink}>
              Privacy settings
              <Icon name="arrowRight" size={14} />
            </Link>
          </section>
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
