import type { DeviceSessionView } from '@ogc/types';
import { changePasswordRequestSchema } from '@ogc/validation';
import { type SyntheticEvent, useCallback, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import styles from '../components/social.module.css';
import { Alert, Button, PasswordField, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/form';
import { useResource } from '../lib/use-resource';

const PLATFORM: Record<DeviceSessionView['platform'], string> = {
  WEB: 'Web browser',
  IOS: 'iPhone or iPad',
  ANDROID: 'Android',
  DESKTOP: 'Desktop app',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function DeviceList() {
  const load = useCallback((signal: AbortSignal) => api.sessions(signal), []);
  const { state, reload } = useResource(load);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState<string>();

  async function act(key: string, task: () => Promise<string>) {
    setNotice(undefined);
    setBusy(key);
    try {
      setNotice({ tone: 'success', text: await task() });
      reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(undefined);
    }
  }

  const others = state.status === 'ready' ? state.data.filter((s) => !s.current).length : 0;
  return (
    <section aria-labelledby="devices-heading">
      <h2 id="devices-heading" className={styles.legend}>
        Signed-in devices
      </h2>
      <p className={styles.muted}>
        Sign out a device you no longer use or have lost. It loses access immediately, and its
        encryption keys and notifications are removed.
      </p>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {state.status === 'loading' ? <Spinner label="Loading devices" /> : null}
      {state.status === 'error' ? <Alert>{errorMessage(state.error)}</Alert> : null}
      {state.status === 'ready' ? (
        <ul className={styles.list} aria-label="Signed-in devices">
          {state.data.map((s) => {
            const name = s.deviceName ?? PLATFORM[s.platform];
            return (
              <li key={s.id} className={styles.listItem}>
                <span className={styles.identityRow}>
                  <Icon name="device" size={24} />
                  <span className={styles.names}>
                    <span className={styles.displayNameSmall}>
                      {name}
                      {s.current ? ' · This device' : ''}
                    </span>
                    <span className={styles.muted}>
                      {PLATFORM[s.platform]} · Last active {when(s.lastUsedAt)} · Signed in{' '}
                      {when(s.createdAt)}
                    </span>
                  </span>
                </span>
                {s.current ? null : (
                  <Button
                    variant="secondary"
                    busy={busy === s.id}
                    aria-label={`Sign out ${name}`}
                    onClick={() =>
                      void act(s.id, async () => {
                        await api.revokeSession(s.id);
                        return `${name} was signed out.`;
                      })
                    }
                  >
                    Sign out
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {others > 0 ? (
        <Button
          variant="danger"
          busy={busy === 'others'}
          onClick={() =>
            void act('others', async () => {
              const { ended } = await api.revokeOtherSessions();
              return `Signed out ${String(ended)} other ${ended === 1 ? 'device' : 'devices'}.`;
            })
          }
        >
          Sign out all other devices
        </Button>
      ) : null}
    </section>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setNotice(undefined);
    const parsed = changePasswordRequestSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const { otherSessionsEnded } = await api.changePassword(parsed.data);
      setCurrentPassword('');
      setNewPassword('');
      setNotice({
        tone: 'success',
        text:
          otherSessionsEnded > 0
            ? `Password changed. ${String(otherSessionsEnded)} other ${otherSessionsEnded === 1 ? 'device was' : 'devices were'} signed out.`
            : 'Password changed.',
      });
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="password-heading">
      <h2 id="password-heading" className={styles.legend}>
        Change password
      </h2>
      <p className={styles.muted}>
        Every other device is signed out when you change your password. Use at least 12 characters;
        a few unrelated words work well.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          value={currentPassword}
          error={errors.currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
          }}
        />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={newPassword}
          error={errors.newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
          }}
        />
        <Button type="submit" busy={busy}>
          Change password
        </Button>
      </form>
    </section>
  );
}

/** Devices & security: signed-in devices (sessions) and password change. */
export function SecurityPage() {
  return (
    <AppShell title="Devices & security">
      <DeviceList />
      <ChangePasswordForm />
    </AppShell>
  );
}
