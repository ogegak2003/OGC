import type { PrivacySettings, ReportCategory } from '@ogc/types';
import {
  REPORT_DESCRIPTION_MAX_LENGTH,
  formatOgcIdForDisplay,
  normalizeOgcId,
  reportUserRequestSchema,
} from '@ogc/validation';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Notice } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useResource } from '../../lib/use-resource';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from './styles';

function Choice({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      style={[social.option, selected && social.optionSelected]}
      onPress={onSelect}
    >
      <Text style={social.menuText}>{label}</Text>
      <Text style={social.muted}>{description}</Text>
    </Pressable>
  );
}

function PrivacyForm({ initial }: { initial: PrivacySettings }) {
  const { client } = useAuth();
  const [settings, setSettings] = useState(initial);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      setSettings((await client.updateProfile({ privacy: settings })).privacy);
      setNotice({ tone: 'success', text: 'Privacy settings saved.' });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <Text style={social.label}>WHO CAN SEE YOUR PHOTO AND BIO</Text>
      <Choice
        label="My contacts"
        description="Others see only your name and OGC ID."
        selected={settings.profileVisibility === 'CONTACTS'}
        onSelect={() => {
          setSettings((s) => ({ ...s, profileVisibility: 'CONTACTS' }));
        }}
      />
      <Choice
        label="Everyone"
        description="Anyone who finds your OGC ID."
        selected={settings.profileVisibility === 'EVERYONE'}
        onSelect={() => {
          setSettings((s) => ({ ...s, profileVisibility: 'EVERYONE' }));
        }}
      />
      <Text style={social.label}>WHO CAN FIND YOU</Text>
      <Choice
        label="Anyone with my OGC ID"
        description="Recommended, so people can add you."
        selected={settings.discoverable}
        onSelect={() => {
          setSettings((s) => ({ ...s, discoverable: true }));
        }}
      />
      <Choice
        label="Only my existing contacts"
        description="New people cannot find or add you."
        selected={!settings.discoverable}
        onSelect={() => {
          setSettings((s) => ({ ...s, discoverable: false }));
        }}
      />
      <Text style={social.label}>WHO CAN SEND CONTACT REQUESTS</Text>
      <Choice
        label="Anyone who can find me"
        description="You decide on each request."
        selected={settings.contactRequests === 'EVERYONE'}
        onSelect={() => {
          setSettings((s) => ({ ...s, contactRequests: 'EVERYONE' }));
        }}
      />
      <Choice
        label="Nobody"
        description="You can still send requests yourself."
        selected={settings.contactRequests === 'NOBODY'}
        onSelect={() => {
          setSettings((s) => ({ ...s, contactRequests: 'NOBODY' }));
        }}
      />
      <Button title="Save privacy settings" busy={busy} onPress={() => void save()} />
    </>
  );
}

export function PrivacyScreen() {
  const { client } = useAuth();
  const nav = useNavigation();
  const load = useCallback(() => client.profile(), [client]);
  const { state } = useResource(load);
  return (
    <Screen title="Privacy" onBack={nav.back}>
      {state.status === 'ready' ? <PrivacyForm initial={state.data.privacy} /> : null}
      {state.status === 'loading' ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {state.status === 'error' ? <Notice>{errorMessage(state.error)}</Notice> : null}
    </Screen>
  );
}

export function BlockedScreen() {
  const { client } = useAuth();
  const nav = useNavigation();
  const load = useCallback(() => client.blocks(), [client]);
  const { state, reload } = useResource(load);
  const [error, setError] = useState<string>();

  async function unblock(ogcId: string) {
    try {
      await client.unblock(ogcId);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Screen title="Blocked people" onBack={nav.back}>
      <Text style={social.muted}>
        Blocked people cannot find you or send you requests. They are not told.
      </Text>
      {error ? <Notice>{error}</Notice> : null}
      {state.status === 'loading' ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {state.status === 'ready' && state.data.items.length === 0 ? (
        <Text style={social.empty}>You have not blocked anyone.</Text>
      ) : null}
      {state.status === 'ready'
        ? state.data.items.map((b) => (
            <View key={b.profile.ogcId} style={social.listItem}>
              <View style={social.names}>
                <Text style={social.menuText}>{b.profile.displayName}</Text>
                <Text style={social.ogcId}>{formatOgcIdForDisplay(b.profile.ogcId)}</Text>
              </View>
              <Button
                title="Unblock"
                variant="secondary"
                onPress={() => void unblock(b.profile.ogcId)}
              />
            </View>
          ))
        : null}
    </Screen>
  );
}

const CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: 'SPAM', label: 'Spam or unwanted contact' },
  { value: 'HARASSMENT', label: 'Harassment or bullying' },
  { value: 'IMPERSONATION', label: 'Pretending to be someone else' },
  { value: 'INAPPROPRIATE_CONTENT', label: 'Inappropriate profile content' },
  { value: 'SCAM_OR_FRAUD', label: 'Scam or fraud' },
  { value: 'OTHER', label: 'Something else' },
];

export function ReportScreen({ ogcId }: { ogcId: string }) {
  const { client } = useAuth();
  const canonical = normalizeOgcId(ogcId);
  const displayId = canonical ? formatOgcIdForDisplay(canonical) : ogcId;
  const nav = useNavigation();
  const [category, setCategory] = useState<ReportCategory>();
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = reportUserRequestSchema.safeParse({ ogcId, category, description });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await client.reportUser({
        ogcId: parsed.data.ogcId,
        category: parsed.data.category,
        description,
      });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Report" onBack={nav.back}>
      {sent ? (
        <Notice tone="success">Thank you. Our moderators will review your report.</Notice>
      ) : (
        <>
          <Text style={social.muted}>
            Reporting {displayId}. Reports are confidential — the person is not told.
          </Text>
          {error ? <Notice>{error}</Notice> : null}
          {CATEGORIES.map((c) => (
            <Choice
              key={c.value}
              label={c.label}
              description=""
              selected={category === c.value}
              onSelect={() => {
                setCategory(c.value);
              }}
            />
          ))}
          <TextInput
            accessibilityLabel="Details (optional)"
            placeholder="Details (optional)"
            style={social.input}
            multiline
            value={description}
            maxLength={REPORT_DESCRIPTION_MAX_LENGTH}
            onChangeText={setDescription}
          />
          <Button title="Send report" busy={busy} onPress={() => void submit()} />
        </>
      )}
    </Screen>
  );
}
