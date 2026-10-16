import type { DeviceSessionView } from '@ogc/types';
import { changePasswordRequestSchema } from '@ogc/validation';
import { type SyntheticEvent, useCallback, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Icon, type IconName } from '../components/Icon';
import { ConfirmDialog, PageIntro, Section, SettingRow } from '../components/kit';
import kit from '../components/kit.module.css';
import { Alert, Button, PasswordField, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/form';
import { useResource } from '../lib/use-resource';
import styles from './SecurityPage.module.css';

const PLATFORM: Record<DeviceSessionView['platform'], string> = {
  WEB: 'Web browser',
  IOS: 'iPhone or iPad',
  ANDROID: 'Android',
  DESKTOP: 'Desktop app',
};

const PLATFORM_ICON: Record<DeviceSessionView['platform'], IconName> = {
  WEB: 'compass',
  IOS: 'device',
  ANDROID: 'device',
  DESKTOP: 'sidebar',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type Pending = { kind: 'one'; session: DeviceSessionView; name: string } | { kind: 'others' };

function DeviceList() {
  const load = useCallback((signal: AbortSignal) => api.sessions(signal), []);
  const { state, reload } = useResource(load);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);

  async function confirm(action: Pending) {
    setNotice(undefined);
    setBusy(true);
    try {
      if (action.kind === 'one') {
        await api.revokeSession(action.session.id);
        setNotice({ tone: 'success', text: `${action.name} was signed out.` });
      } else {
        const { ended } = await api.revokeOtherSessions();
        setNotice({
          tone: 'success',
          text: `Signed out ${String(ended)} other ${ended === 1 ? 'device' : 'devices'}.`,
        });
      }
      setPending(undefined);
      reload();
    } catch (e) {
      setPending(undefined);
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  const others = state.status === 'ready' ? state.data.filter((s) => !s.current).length : 0;
  return (
    <Section
      title="Signed-in devices"
      description="Sign out a device you no longer use or have lost. It loses access immediately, and its encryption keys and notifications are removed."
    >
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {state.status === 'loading' ? (
        <div className={styles.devices} role="status" aria-label="Loading devices">
          <Skeleton height="4rem" />
          <Skeleton height="4rem" />
        </div>
      ) : null}
      {state.status === 'error' ? <Alert>{errorMessage(state.error)}</Alert> : null}
      {state.status === 'ready' ? (
        <ul className={styles.devices} aria-label="Signed-in devices">
          {state.data.map((s) => {
            const name = s.deviceName ?? PLATFORM[s.platform];
            return (
              <li key={s.id} className={s.current ? styles.deviceCurrent : styles.device}>
                <span className={styles.deviceIcon} aria-hidden="true">
                  <Icon name={PLATFORM_ICON[s.platform]} size={20} />
                </span>
                <span className={styles.deviceText}>
                  <span className={styles.deviceName}>
                    {name}
                    {s.current ? <span className={styles.here}> · This device</span> : null}
                  </span>
                  <span className={styles.deviceMeta}>
                    {PLATFORM[s.platform]} · Last active {when(s.lastUsedAt)} · Signed in{' '}
                    {when(s.createdAt)}
                  </span>
                </span>
                {s.current ? null : (
                  <Button
                    variant="secondary"
                    aria-label={`Sign out ${name}`}
                    onClick={() => {
                      setPending({ kind: 'one', session: s, name });
                    }}
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
        <div>
          <Button
            variant="danger"
            icon="logout"
            onClick={() => {
              setPending({ kind: 'others' });
            }}
          >
            Sign out all other devices
          </Button>
        </div>
      ) : null}
      {pending ? (
        <ConfirmDialog
          title={
            pending.kind === 'one' ? `Sign out ${pending.name}?` : 'Sign out all other devices?'
          }
          confirmLabel={pending.kind === 'one' ? 'Sign out device' : 'Sign out others'}
          busy={busy}
          onCancel={() => {
            setPending(undefined);
          }}
          onConfirm={() => void confirm(pending)}
        >
          <p>
            {pending.kind === 'one'
              ? 'It loses access immediately. Its encryption keys and notifications are removed, so it can’t read new messages.'
              : `${String(others)} ${others === 1 ? 'device loses' : 'devices lose'} access immediately. This device stays signed in.`}
          </p>
        </ConfirmDialog>
      ) : null}
    </Section>
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
    <Section
      title="Change password"
      description="Every other device is signed out when you change your password. Use at least 12 characters; a few unrelated words work well."
    >
      <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
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
        <div>
          <Button type="submit" busy={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** Devices & security: signed-in devices (sessions), password change, recovery and encryption. */
export function SecurityPage() {
  return (
    <AppShell title="Devices & security">
      <div className={kit.sectionBody}>
        <PageIntro>
          Manage where you are signed in and how your account is protected. OGC never shows your
          password, keys or sign-in tokens.
        </PageIntro>
        <DeviceList />
        <ChangePasswordForm />
        <Section title="Account recovery">
          <p className={styles.note}>
            <Icon name="mail" size={18} />
            <span>
              Forgot your password? Choose “Forgot password” on the sign-in page and OGC emails a
              single-use reset link to your account’s email address. Resetting signs out every
              device.
            </span>
          </p>
        </Section>
        <Section title="Encryption and safety numbers">
          <p className={styles.note}>
            <Icon name="shieldCheck" size={18} />
            <span>
              Direct and group messages are end-to-end encrypted. To check you are talking to the
              right person, compare safety numbers in a conversation’s details. If someone’s
              security keys change, OGC warns you in that conversation.
            </span>
          </p>
          <SettingRow
            icon="chat"
            title="Open your conversations"
            detail="Safety numbers are in each conversation’s details."
            to="/messages"
          />
        </Section>
      </div>
    </AppShell>
  );
}
