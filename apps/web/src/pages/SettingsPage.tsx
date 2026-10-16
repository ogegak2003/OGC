import { ACCENT_LABELS } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useCallback } from 'react';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { Section, SettingRow } from '../components/kit';
import kit from '../components/kit.module.css';
import { Button } from '../components/ui';
import { useAuth } from '../auth/auth-context';
import { api } from '../lib/api';
import { useResource } from '../lib/use-resource';
import { useTheme } from '../theme/theme';
import styles from './SettingsPage.module.css';

const MODE_LABEL = { dark: 'Obsidian (dark)', light: 'Ivory (light)', system: 'Match system' };

/**
 * `/settings`: every account setting in one place. Each row opens the page that owns the
 * setting; nothing is changed here except signing out.
 */
export function SettingsPage() {
  const { state, logout } = useAuth();
  const { preference, accent } = useTheme();
  // The photo lives on the profile, not the account.
  const load = useCallback((signal: AbortSignal) => api.profile(signal), []);
  const { state: profile } = useResource(load);
  if (state.status !== 'signed-in') return null;
  const account = state.account;
  return (
    <AppShell title="Settings">
      <div className={kit.sectionBody}>
        <div className={styles.account}>
          <Avatar
            url={profile.status === 'ready' ? profile.data.avatarUrl : null}
            name={account.displayName}
            size={56}
          />
          <span className={styles.accountText}>
            <span className={styles.name}>{account.displayName}</span>
            <span className={styles.ogcId}>{formatOgcIdForDisplay(account.ogcId)}</span>
          </span>
        </div>

        <Section title="Account">
          <SettingRow icon="user" title="Profile" detail="Name, photo and bio" to="/profile/edit" />
          <SettingRow
            icon="qr"
            title="Your public profile"
            detail="What people see when they find your OGC ID"
            to={`/id/${account.ogcId}`}
          />
          <SettingRow
            icon="shieldCheck"
            title="Devices & security"
            detail="Signed-in devices, password and recovery"
            to="/settings/security"
          />
        </Section>

        <Section title="Preferences">
          <SettingRow
            icon="palette"
            title="Appearance"
            detail={`${MODE_LABEL[preference]} · ${ACCENT_LABELS[accent]}`}
            to="/settings/appearance"
          />
          <SettingRow
            icon="bell"
            title="Notifications"
            detail="What reaches your phone, previews and quiet hours"
            to="/settings/notifications"
          />
        </Section>

        <Section title="Privacy & safety">
          <SettingRow
            icon="eye"
            title="Privacy"
            detail="Who can find you, see your profile and send you requests"
            to="/settings/privacy"
          />
          <SettingRow
            icon="ban"
            title="Blocked people"
            detail="People who can’t contact you"
            to="/settings/blocked"
          />
        </Section>

        <div>
          <Button variant="secondary" icon="logout" onClick={() => void logout()}>
            Sign out of this device
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
