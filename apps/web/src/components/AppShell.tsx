import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { useMessaging } from '../messaging/messaging-context';
import styles from './AppShell.module.css';
import { OgcMark } from './OgcMark';
import { Button } from './ui';

const NAV = [
  { to: '/messages', label: 'Messages' },
  { to: '/channels', label: 'Channels' },
  { to: '/notifications', label: 'Alerts' },
  { to: '/contacts', label: 'Contacts' },
  { to: '/home', label: 'My OGC' },
  { to: '/discover', label: 'Discover' },
  { to: '/settings/privacy', label: 'Privacy' },
] as const;

/** Destinations that fit the phone tab bar; the rest sit behind "More". */
const TABS = 4;

/**
 * Signed-in layout: brand, primary navigation and content. Wide screens show
 * every destination in the header; narrower screens get a bottom tab bar
 * whose last tab ("More") opens the remaining destinations and sign-out.
 * `layout="full"` gives the content the full viewport height (messaging);
 * `focused` hides the tab bar on narrow screens (an open conversation, whose
 * own back button returns to the list) so the composer has the room.
 */
export function AppShell({
  title,
  children,
  layout = 'page',
  focused = false,
}: {
  title: string;
  children: ReactNode;
  layout?: 'page' | 'full';
  focused?: boolean;
}) {
  const { logout } = useAuth();
  const { unreadTotal, notificationsUnread } = useMessaging();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const moreRef = useRef<HTMLDivElement>(null);

  // Close the "More" sheet on Escape or a tap elsewhere (and when one of its links is used).
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [moreOpen]);

  const badge = (to: string) => {
    const count =
      to === '/messages' ? unreadTotal : to === '/notifications' ? notificationsUnread : 0;
    if (count <= 0) return null;
    const label =
      to === '/messages' ? `${String(count)} unread` : `${String(count)} new notifications`;
    return (
      <span className={styles.navBadge} aria-label={label}>
        {count > 99 ? '99+' : count}
      </span>
    );
  };
  const link = (item: (typeof NAV)[number], extra = '') => (
    <NavLink
      key={item.to}
      to={item.to}
      onClick={() => {
        setMoreOpen(false);
      }}
      className={({ isActive }) =>
        [styles.link, extra, isActive ? styles.active : ''].filter(Boolean).join(' ')
      }
    >
      {item.label}
      {badge(item.to)}
    </NavLink>
  );
  const secondary = NAV.slice(TABS);
  const inSecondary = secondary.some((item) => pathname.startsWith(item.to));

  return (
    <div className={[styles.shell, focused ? styles.focused : ''].join(' ')}>
      <header className={styles.header}>
        <span className={styles.logo}>
          <OgcMark size={28} />
          OGC
        </span>
        <nav className={styles.wideNav} aria-label="Main">
          {NAV.map((item) => link(item))}
        </nav>
        <Button variant="ghost" className={styles.signOut} onClick={() => void logout()}>
          Sign out
        </Button>
      </header>
      <nav className={styles.tabBar} aria-label="Main">
        {NAV.slice(0, TABS).map((item) => link(item, styles.tab))}
        <div className={styles.moreWrap} ref={moreRef}>
          <button
            type="button"
            className={[styles.link, styles.tab, inSecondary ? styles.active : ''].join(' ')}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => {
              setMoreOpen((open) => !open);
            }}
          >
            More
          </button>
          <div id={moreId} className={styles.moreSheet} hidden={!moreOpen}>
            {secondary.map((item) => link(item, styles.moreLink))}
            <button
              type="button"
              className={[styles.link, styles.moreLink].join(' ')}
              onClick={() => void logout()}
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main className={layout === 'full' ? styles.full : styles.main}>
        <h1 className={layout === 'full' ? styles.visuallyHidden : styles.title}>{title}</h1>
        {children}
      </main>
    </div>
  );
}
