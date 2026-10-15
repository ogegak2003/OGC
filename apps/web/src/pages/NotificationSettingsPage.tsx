import type { NotificationSettingsView } from '@ogc/types';
import type { NotificationSettingsUpdate } from '@ogc/validation';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Alert, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useResource } from '../lib/use-resource';
import styles from './NotificationSettingsPage.module.css';

function toTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function fromTime(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute < 1440 ? minute : undefined;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

type Flag =
  | 'enabled'
  | 'messages'
  | 'groups'
  | 'channels'
  | 'contactRequests'
  | 'calls'
  | 'sound'
  | 'vibration';

function Switch({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={styles.row}>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </label>
  );
}

/**
 * `/settings/notifications`: the account's push preferences, saved on the server and shared
 * by all its devices (they apply to the mobile app's push notifications). The web app shows
 * notifications in its notification center while it is open; browser push is not offered.
 */
export function NotificationSettingsPage() {
  const load = useCallback((signal: AbortSignal) => api.notificationSettings(signal), []);
  const { state, reload } = useResource(load);
  const [edited, setEdited] = useState<NotificationSettingsView>();
  const [status, setStatus] = useState<{ kind: 'saving' | 'saved' | 'error'; text: string }>();
  const settings = edited ?? (state.status === 'ready' ? state.data : undefined);

  const save = (update: NotificationSettingsUpdate, next: NotificationSettingsView) => {
    const previous = settings;
    setEdited(next);
    setStatus({ kind: 'saving', text: 'Saving…' });
    api.updateNotificationSettings(update).then(
      (saved) => {
        setEdited(saved);
        setStatus({ kind: 'saved', text: 'Saved' });
      },
      () => {
        setEdited(previous);
        setStatus({
          kind: 'error',
          text: 'Your notification settings could not be saved. Check your connection and try again.',
        });
      },
    );
  };

  const flag = (key: Flag) => (value: boolean) => {
    if (settings) save({ [key]: value }, { ...settings, [key]: value });
  };

  const quiet = (patch: Partial<NotificationSettingsView['quietHours']>) => {
    if (!settings) return;
    const next = { ...settings.quietHours, ...patch };
    if (next.start === next.end) return; // the server refuses an empty window
    save({ quietHours: next }, { ...settings, quietHours: next });
  };

  const off = settings ? !settings.enabled : true;
  const zone = browserTimeZone();

  return (
    <AppShell title="Notification settings">
      <p className={styles.intro}>
        These settings are saved to your account and used by every device you sign in on. Message
        text is never sent in a notification. On the web, OGC shows new activity in your{' '}
        <Link to="/notifications">notification center</Link> while the page is open; browser push
        notifications are not available.
      </p>

      {state.status === 'loading' ? <Spinner label="Loading notification settings" /> : null}
      {state.status === 'error' ? (
        <Alert>
          Your notification settings could not be loaded.{' '}
          <button type="button" className={styles.linkButton} onClick={reload}>
            Retry
          </button>
        </Alert>
      ) : null}
      {status?.kind === 'error' ? <Alert>{status.text}</Alert> : null}
      <p className={styles.status} role="status" aria-live="polite">
        {status && status.kind !== 'error' ? status.text : ''}
      </p>

      {settings ? (
        <>
          <section className={styles.card} aria-labelledby="push-heading">
            <h2 id="push-heading" className={styles.heading}>
              Push notifications
            </h2>
            <Switch
              label="Push notifications"
              description="Off: nothing is pushed to your phones. You still see everything when you open OGC."
              checked={settings.enabled}
              onChange={flag('enabled')}
            />
          </section>

          <section className={styles.card} aria-labelledby="what-heading">
            <h2 id="what-heading" className={styles.heading}>
              What to notify
            </h2>
            <Switch
              label="Direct messages"
              checked={settings.messages}
              disabled={off}
              onChange={flag('messages')}
            />
            <Switch
              label="Groups"
              description="Group messages, mentions and invitations"
              checked={settings.groups}
              disabled={off}
              onChange={flag('groups')}
            />
            <Switch
              label="Channels"
              description="Announcements and channel updates"
              checked={settings.channels}
              disabled={off}
              onChange={flag('channels')}
            />
            <Switch
              label="Contact requests"
              checked={settings.contactRequests}
              disabled={off}
              onChange={flag('contactRequests')}
            />
            <Switch
              label="Calls"
              description="Incoming and missed calls"
              checked={settings.calls}
              disabled={off}
              onChange={flag('calls')}
            />
            <p className={styles.description}>
              To mute one chat or group, open it and change its notification settings.
            </p>
          </section>

          <section className={styles.card} aria-labelledby="preview-heading">
            <fieldset className={styles.fieldset} disabled={off}>
              <legend id="preview-heading" className={styles.heading}>
                Notification preview
              </legend>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="preview"
                  checked={settings.preview === 'GENERIC'}
                  onChange={() => {
                    save({ preview: 'GENERIC' }, { ...settings, preview: 'GENERIC' });
                  }}
                />
                <span>
                  <span className={styles.label}>Private (recommended)</span>
                  <span className={styles.description}>
                    “OGC — New message”. Nothing about who wrote is shared with Apple, Google or
                    Expo.
                  </span>
                </span>
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="preview"
                  checked={settings.preview === 'SENDER'}
                  onChange={() => {
                    save({ preview: 'SENDER' }, { ...settings, preview: 'SENDER' });
                  }}
                />
                <span>
                  <span className={styles.label}>Show the sender</span>
                  <span className={styles.description}>
                    The sender’s name (and group name) appears in the notification and passes
                    through Apple, Google and Expo’s push services. Message text is never included.
                  </span>
                </span>
              </label>
            </fieldset>
          </section>

          <section className={styles.card} aria-labelledby="sound-heading">
            <h2 id="sound-heading" className={styles.heading}>
              Sound and quiet hours
            </h2>
            <Switch
              label="Sound"
              checked={settings.sound}
              disabled={off}
              onChange={flag('sound')}
            />
            <Switch
              label="Vibration"
              checked={settings.vibration}
              disabled={off}
              onChange={flag('vibration')}
            />
            <Switch
              label="Quiet hours"
              description="Notifications arrive silently, without sound or vibration."
              checked={settings.quietHours.enabled}
              disabled={off}
              onChange={(enabled) => {
                quiet({ enabled, timeZone: zone });
              }}
            />
            {settings.quietHours.enabled ? (
              <div className={styles.times}>
                <label className={styles.time}>
                  From
                  <input
                    type="time"
                    step={1800}
                    value={toTime(settings.quietHours.start)}
                    disabled={off}
                    onChange={(event) => {
                      const start = fromTime(event.target.value);
                      if (start !== undefined) quiet({ start });
                    }}
                  />
                </label>
                <label className={styles.time}>
                  Until
                  <input
                    type="time"
                    step={1800}
                    value={toTime(settings.quietHours.end)}
                    disabled={off}
                    onChange={(event) => {
                      const end = fromTime(event.target.value);
                      if (end !== undefined) quiet({ end });
                    }}
                  />
                </label>
                <p className={styles.description}>
                  Time zone: {settings.quietHours.timeZone}
                  {settings.quietHours.timeZone !== zone ? (
                    <>
                      {' '}
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          quiet({ timeZone: zone });
                        }}
                      >
                        Use this browser’s time zone ({zone})
                      </button>
                    </>
                  ) : null}
                </p>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
