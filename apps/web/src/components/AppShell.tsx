import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { useMessaging } from '../messaging/messaging-context';
import styles from './AppShell.module.css';
import { OgcMark } from './OgcMark';
import { Button } from './ui';

const NAV = [
  { to: '/messages', label: 'Messages' },
  { to: '/channels', label: 'Channels' },
  { to: '/notifications', label: 'Alerts' },
  { to: '/home', label: 'My OGC' },
  { to: '/discover', label: 'Discover' },
  { to: '/contacts', label: 'Contacts' },
  { to: '/settings/privacy', label: 'Privacy' },
] as const;

/**
 * Signed-in layout: brand, primary navigation (bottom bar on phones), and content.
 * `layout="full"` gives the content the full viewport height (messaging).
 */
export function AppShell({
  title,
  children,
  layout = 'page',
}: {
  title: string;
  children: ReactNode;
  layout?: 'page' | 'full';
}) {
  const { logout } = useAuth();
  const { unreadTotal, notificationsUnread } = useMessaging();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.logo}>
          <OgcMark size={28} />
          OGC
        </span>
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => [styles.link, isActive ? styles.active : ''].join(' ')}
            >
              {item.label}
              {item.to === '/messages' && unreadTotal > 0 ? (
                <span className={styles.navBadge} aria-label={`${String(unreadTotal)} unread`}>
                  {unreadTotal > 99 ? '99+' : unreadTotal}
                </span>
              ) : null}
              {item.to === '/notifications' && notificationsUnread > 0 ? (
                <span
                  className={styles.navBadge}
                  aria-label={`${String(notificationsUnread)} new notifications`}
                >
                  {notificationsUnread > 99 ? '99+' : notificationsUnread}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <Button variant="ghost" onClick={() => void logout()}>
          Sign out
        </Button>
      </header>
      <main className={layout === 'full' ? styles.full : styles.main}>
        <h1 className={layout === 'full' ? styles.visuallyHidden : styles.title}>{title}</h1>
        {children}
      </main>
    </div>
  );
}
