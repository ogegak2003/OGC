import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/auth-context';
import styles from './AppShell.module.css';
import { OgcMark } from './OgcMark';
import { Button } from './ui';

const NAV = [
  { to: '/home', label: 'My OGC' },
  { to: '/discover', label: 'Discover' },
  { to: '/contacts', label: 'Contacts' },
  { to: '/settings/privacy', label: 'Privacy' },
] as const;

/** Signed-in layout: brand, primary navigation (bottom bar on phones), and content. */
export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { logout } = useAuth();
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
            </NavLink>
          ))}
        </nav>
        <Button variant="ghost" onClick={() => void logout()}>
          Sign out
        </Button>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>{title}</h1>
        {children}
      </main>
    </div>
  );
}
