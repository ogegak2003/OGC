import type { PrivacySettings } from '@ogc/types';
import { type SyntheticEvent, useCallback, useState } from 'react';
import { AppShell } from '../components/AppShell';
import styles from '../components/social.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import { useResource } from '../lib/use-resource';
import { PageIntro, Section, SettingRow } from '../components/kit';
import kit from '../components/kit.module.css';

interface Choice<T extends string> {
  value: T;
  label: string;
  description: string;
}

function RadioGroup<T extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className={[styles.fieldset, kit.section].join(' ')}>
      <legend className={styles.legend}>{legend}</legend>
      {choices.map((choice) => (
        <label key={choice.value} className={styles.option}>
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => {
              onChange(choice.value);
            }}
          />
          <span className={styles.names}>
            <strong>{choice.label}</strong>
            <span className={styles.muted}>{choice.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function PrivacyForm({ initial }: { initial: PrivacySettings }) {
  const [settings, setSettings] = useState(initial);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState(false);

  async function save(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const updated = await api.updateProfile({ privacy: settings });
      setSettings(updated.privacy);
      setNotice({ tone: 'success', text: 'Privacy settings saved.' });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={kit.sectionBody} onSubmit={(e) => void save(e)}>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <RadioGroup
        legend="Who can see your photo, bio and join date"
        name="profileVisibility"
        value={settings.profileVisibility}
        onChange={(profileVisibility) => {
          setSettings((s) => ({ ...s, profileVisibility }));
        }}
        choices={[
          {
            value: 'CONTACTS',
            label: 'My contacts',
            description: 'Others see only your name and OGC ID.',
          },
          { value: 'EVERYONE', label: 'Everyone', description: 'Anyone who finds your OGC ID.' },
        ]}
      />
      <RadioGroup
        legend="Who can find you by OGC ID or QR code"
        name="discoverable"
        value={settings.discoverable ? 'yes' : 'no'}
        onChange={(v) => {
          setSettings((s) => ({ ...s, discoverable: v === 'yes' }));
        }}
        choices={[
          {
            value: 'yes',
            label: 'Anyone with my OGC ID',
            description: 'Recommended, so people can add you.',
          },
          {
            value: 'no',
            label: 'Only my existing contacts',
            description: 'New people cannot find or add you until you change this.',
          },
        ]}
      />
      <RadioGroup
        legend="Who can send you contact requests"
        name="contactRequests"
        value={settings.contactRequests}
        onChange={(contactRequests) => {
          setSettings((s) => ({ ...s, contactRequests }));
        }}
        choices={[
          {
            value: 'EVERYONE',
            label: 'Anyone who can find me',
            description: 'You decide on each request.',
          },
          {
            value: 'NOBODY',
            label: 'Nobody',
            description: 'You can still send requests yourself.',
          },
        ]}
      />
      <div className={styles.actions}>
        <Button type="submit" busy={busy}>
          Save privacy settings
        </Button>
      </div>
    </form>
  );
}

export function PrivacyPage() {
  const load = useCallback((signal: AbortSignal) => api.profile(signal), []);
  const { state } = useResource(load);
  return (
    <AppShell title="Privacy">
      <div className={kit.sectionBody}>
        <PageIntro>
          Decide who can see your details and reach you. Your email address is never shown to
          anyone, whatever you choose here.
        </PageIntro>
        {state.status === 'loading' ? <Spinner label="Loading settings" /> : null}
        {state.status === 'error' ? <Alert>{errorMessage(state.error)}</Alert> : null}
        {state.status === 'ready' ? <PrivacyForm initial={state.data.privacy} /> : null}
        <Section title="Safety">
          <SettingRow
            icon="ban"
            title="Blocked people"
            detail="See and unblock people you blocked"
            to="/settings/blocked"
          />
          <SettingRow
            icon="shieldCheck"
            title="Security and devices"
            detail="Signed-in devices, password and encryption"
            to="/settings/security"
          />
        </Section>
      </div>
    </AppShell>
  );
}
