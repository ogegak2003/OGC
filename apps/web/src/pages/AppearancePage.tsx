import { AppShell } from '../components/AppShell';
import styles from '../components/social.module.css';
import { ThemeControls } from '../components/ThemeControls';

/** Settings → Appearance: mode and accent, remembered in this browser. */
export function AppearancePage() {
  return (
    <AppShell title="Appearance">
      <p className={styles.muted}>
        Choose how OGC looks in this browser. Obsidian is the default dark appearance; Ivory is the
        light one; System follows your device. Your choice is saved on this device only.
      </p>
      <ThemeControls />
    </AppShell>
  );
}
