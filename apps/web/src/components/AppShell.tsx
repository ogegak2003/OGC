import { LOGO_TAGLINE } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { useMessaging } from '../messaging/messaging-context';
import styles from './AppShell.module.css';
import { Avatar } from './Avatar';
import { GlobalSearch } from './GlobalSearch';
import { Icon, type IconName } from './Icon';
import { OgcLogo } from './OgcLogo';
import { OgcMark } from './OgcMark';

interface Destination {
  to: string;
  label: string;
  icon: IconName;
}

/** The four destinations of the phone tab bar (plus "More"). */
const PRIMARY: Destination[] = [
  { to: '/home', label: 'Home', icon: 'home' },
  { to: '/messages', label: 'Chats', icon: 'chat' },
  { to: '/contacts', label: 'Contacts', icon: 'contacts' },
  { to: '/communities', label: 'Communities', icon: 'community' },
];

const NOTIFICATIONS: Destination = { to: '/notifications', label: 'Notifications', icon: 'bell' };
const CALLS: Destination = { to: '/calls', label: 'Calls', icon: 'phone' };

/** The sidebar on wide screens: every main destination, in the order people use them. */
const SIDEBAR: Destination[] = [
  { to: '/home', label: 'Home', icon: 'home' },
  { to: '/messages', label: 'Chats', icon: 'chat' },
  CALLS,
  { to: '/communities', label: 'Groups', icon: 'community' },
  { to: '/channels', label: 'Channels', icon: 'megaphone' },
  { to: '/contacts', label: 'Contacts', icon: 'contacts' },
  { to: '/discover', label: 'Discover', icon: 'userPlus' },
  NOTIFICATIONS,
];

const SIDEBAR_MORE: Destination[] = [
  { to: '/invitations', label: 'Invitations', icon: 'inbox' },
  { to: '/profile/edit', label: 'Edit profile', icon: 'edit' },
  { to: '/settings/privacy', label: 'Settings', icon: 'settings' },
  { to: '/settings/notifications', label: 'Notification settings', icon: 'bell' },
  { to: '/settings/blocked', label: 'Blocked people', icon: 'ban' },
  { to: '/settings/security', label: 'Devices & security', icon: 'shieldCheck' },
];

/** Everything else on phones, in "More". */
const SECONDARY: Destination[] = [
  CALLS,
  { to: '/discover', label: 'Discover', icon: 'userPlus' },
  { to: '/invitations', label: 'Invitations', icon: 'inbox' },
  { to: '/profile/edit', label: 'Edit profile', icon: 'edit' },
  { to: '/settings/privacy', label: 'Privacy', icon: 'eye' },
  { to: '/settings/notifications', label: 'Notification settings', icon: 'bell' },
  { to: '/settings/blocked', label: 'Blocked people', icon: 'ban' },
  { to: '/settings/security', label: 'Devices & security', icon: 'shieldCheck' },
];

/** Routes that belong to a destination (so it stays highlighted), on phones and in the sidebar. */
const TAB_SECTION: Record<string, string> = {
  '/channels': '/communities',
  '/join': '/communities',
  '/id': '/contacts',
};
const SIDEBAR_SECTION: Record<string, string> = {
  '/join': '/communities',
  '/id': '/contacts',
};

function sectionOf(pathname: string, map: Record<string, string>): string | undefined {
  return Object.entries(map).find(([prefix]) => pathname.startsWith(prefix))?.[1];
}

/** Closes a popover on Escape or a press outside `ref`. */
function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close, ref]);
}

/** The signed-in person in the desktop top bar, with their account menu. */
function ProfileMenu() {
  const { logout, state } = useAuth();
  const { connection } = useMessaging();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismiss(open, close, ref);
  if (state.status !== 'signed-in') return null;
  const account = state.account;
  const online = connection === 'online';
  return (
    <div className={styles.profileWrap} ref={ref}>
      <button
        type="button"
        className={styles.profile}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account: ${account.displayName}`}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className={styles.profileAvatar}>
          <Avatar url={null} name={account.displayName} size={40} />
          <span
            className={online ? styles.presenceOnline : styles.presenceOffline}
            title={online ? 'Connected' : 'Reconnecting'}
          />
        </span>
        <span className={styles.profileText}>
          <span className={styles.profileName}>{account.displayName}</span>
          <span className={styles.profileId}>{formatOgcIdForDisplay(account.ogcId)}</span>
        </span>
        <Icon name="chevronDown" size={18} className={styles.chevron} />
      </button>
      <div id={menuId} className={styles.menu} hidden={!open}>
        <Link className={styles.menuLink} to={`/id/${account.ogcId}`} onClick={close}>
          <Icon name="user" size={20} />
          My public profile
        </Link>
        <Link className={styles.menuLink} to="/profile/edit" onClick={close}>
          <Icon name="edit" size={20} />
          Edit profile
        </Link>
        <Link className={styles.menuLink} to="/settings/privacy" onClick={close}>
          <Icon name="settings" size={20} />
          Settings
        </Link>
        <button
          type="button"
          className={[styles.menuLink, styles.danger].join(' ')}
          onClick={() => void logout()}
        >
          <Icon name="logout" size={20} />
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * Signed-in layout. Wide screens (≥1024px) get a sidebar with every destination, and a top bar
 * with search, notifications and the account; narrower screens get a compact top bar (with
 * search on demand) and a bottom tab bar whose last tab ("More") opens the remaining
 * destinations and sign-out. `layout="full"` gives the content the full height
 * (messaging); `focused` hides the phone bars (an open conversation, whose own back button
 * returns to the list). `width="wide"` lets dashboards use more of large screens. `hideTitle`
 * keeps the page heading for screen readers only (pages with their own header).
 */
export function AppShell({
  title,
  children,
  layout = 'page',
  width = 'default',
  focused = false,
  hideTitle = false,
  aside,
}: {
  title: string;
  children: ReactNode;
  layout?: 'page' | 'full';
  width?: 'default' | 'wide';
  focused?: boolean;
  hideTitle?: boolean;
  /** Contextual panel beside the content on wide screens (below it on narrow ones). */
  aside?: ReactNode;
}) {
  const { logout, state } = useAuth();
  const { unreadTotal, notificationsUnread } = useMessaging();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const moreId = useId();
  const moreRef = useRef<HTMLDivElement>(null);
  const closeMore = useCallback(() => {
    setMoreOpen(false);
  }, []);
  useDismiss(moreOpen, closeMore, moreRef);
  const account = state.status === 'signed-in' ? state.account : undefined;
  const tabSection = sectionOf(pathname, TAB_SECTION);
  const sideSection = sectionOf(pathname, SIDEBAR_SECTION);

  const count = (to: string) =>
    to === '/messages' ? unreadTotal : to === '/notifications' ? notificationsUnread : 0;
  const badge = (to: string) => {
    const n = count(to);
    if (n <= 0) return null;
    const label = to === '/messages' ? `${String(n)} unread` : `${String(n)} new notifications`;
    return (
      <span className={styles.badge} aria-label={label}>
        {n > 99 ? '99+' : n}
      </span>
    );
  };
  const link = (item: Destination, className: string | undefined, section?: string) => (
    <NavLink
      key={item.to}
      to={item.to}
      onClick={closeMore}
      className={({ isActive }) =>
        [className, isActive || section === item.to ? styles.active : ''].filter(Boolean).join(' ')
      }
    >
      <Icon name={item.icon} size={22} className={styles.navIcon} />
      <span className={styles.navLabel}>{item.label}</span>
      {badge(item.to)}
    </NavLink>
  );
  const inSecondary = [NOTIFICATIONS, ...SECONDARY].some((item) => pathname.startsWith(item.to));
  const notificationsLabel =
    notificationsUnread > 0 ? `Notifications, ${String(notificationsUnread)} new` : 'Notifications';

  return (
    <div className={[styles.shell, focused ? styles.focused : ''].join(' ')}>
      <aside className={styles.sidebar}>
        <Link to="/home" className={styles.sideBrand} aria-label="OGC home">
          <OgcLogo height={36} />
          <span className={styles.tagline}>{LOGO_TAGLINE}</span>
        </Link>
        <nav className={styles.sideNav} aria-label="Main">
          {SIDEBAR.map((item) => link(item, styles.sideLink, sideSection))}
          <p className={styles.sideHeading}>Settings & more</p>
          {SIDEBAR_MORE.map((item) => link(item, styles.sideLink, sideSection))}
        </nav>
        {account ? (
          <div className={styles.account}>
            <p className={styles.accountMotto}>One ID. A world of possibilities.</p>
            <div className={styles.accountRow}>
              <Avatar url={null} name={account.displayName} size={36} />
              <span className={styles.accountText}>
                <span className={styles.accountName}>{account.displayName}</span>
                <span className={styles.accountId}>{formatOgcIdForDisplay(account.ogcId)}</span>
              </span>
              <button
                type="button"
                className={styles.signOut}
                onClick={() => void logout()}
                aria-label="Sign out"
                title="Sign out"
              >
                <Icon name="logout" size={18} />
              </button>
            </div>
          </div>
        ) : null}
      </aside>

      <div className={styles.column}>
        <header className={styles.deskBar}>
          <GlobalSearch />
          <div className={styles.deskActions}>
            <Link to="/notifications" className={styles.topAction} aria-label={notificationsLabel}>
              <Icon name="bell" size={22} />
              {notificationsUnread > 0 ? (
                <span className={styles.countDot} aria-hidden="true">
                  {notificationsUnread > 99 ? '99+' : notificationsUnread}
                </span>
              ) : null}
            </Link>
            <ProfileMenu />
          </div>
        </header>

        <header className={styles.topBar}>
          <Link to="/home" className={styles.brand} aria-label="OGC home">
            <OgcMark size={26} />
            <span>OGC</span>
          </Link>
          <div className={styles.topActions}>
            <button
              type="button"
              className={styles.topAction}
              aria-label="Search"
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((open) => !open);
              }}
            >
              <Icon name={searchOpen ? 'close' : 'search'} size={22} />
            </button>
            <Link to="/notifications" className={styles.topAction} aria-label={notificationsLabel}>
              <Icon name="bell" size={22} />
              {notificationsUnread > 0 ? <span className={styles.dot} aria-hidden="true" /> : null}
            </Link>
          </div>
        </header>
        {searchOpen ? (
          <div className={styles.searchRow}>
            <GlobalSearch
              autoFocus
              onDone={() => {
                setSearchOpen(false);
              }}
            />
          </div>
        ) : null}

        <main
          className={[
            layout === 'full' ? styles.full : styles.main,
            width === 'wide' && layout !== 'full' ? styles.wide : '',
          ].join(' ')}
        >
          <h1 className={layout === 'full' || hideTitle ? styles.visuallyHidden : styles.title}>
            {title}
          </h1>
          {aside ? (
            <div className={styles.withAside}>
              <div className={styles.content}>{children}</div>
              <aside className={styles.aside}>{aside}</aside>
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      <nav className={styles.tabBar} aria-label="Main">
        {PRIMARY.map((item) => link(item, styles.tab, tabSection))}
        <div className={styles.moreWrap} ref={moreRef}>
          <button
            type="button"
            className={[styles.tab, inSecondary ? styles.active : ''].join(' ')}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => {
              setMoreOpen((open) => !open);
            }}
          >
            <Icon name="moreHorizontal" size={22} className={styles.navIcon} />
            <span className={styles.navLabel}>More</span>
            {notificationsUnread > 0 ? <span className={styles.tabDot} aria-hidden="true" /> : null}
          </button>
          <div id={moreId} className={styles.moreSheet} hidden={!moreOpen}>
            {[NOTIFICATIONS, ...SECONDARY].map((item) => link(item, styles.moreLink))}
            <button
              type="button"
              className={[styles.moreLink, styles.danger].join(' ')}
              onClick={() => void logout()}
            >
              <Icon name="logout" size={22} className={styles.navIcon} />
              <span className={styles.navLabel}>Sign out</span>
            </button>
          </div>
        </div>
      </nav>
    </div>
  );
}
