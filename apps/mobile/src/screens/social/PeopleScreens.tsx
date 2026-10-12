import type {
  ContactRequestView,
  ContactView,
  Page,
  ProfileSummary,
  PublicProfile,
} from '@ogc/types';
import { formatOgcIdForDisplay, ogcIdInputSchema } from '@ogc/validation';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../../components/identity';
import { Button, Field, Notice } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useResource } from '../../lib/use-resource';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from './styles';

const RELATIONSHIP_LABEL: Record<PublicProfile['relationship'], string | null> = {
  SELF: 'This is you',
  NONE: null,
  OUTGOING_REQUEST: 'Request sent',
  INCOMING_REQUEST: 'Wants to connect with you',
  CONTACT: 'Contact',
  BLOCKED: 'Blocked',
};

/** A profile with the actions its relationship allows; re-reads from the server after each action. */
function ProfileCard({ profile, onChanged }: { profile: PublicProfile; onChanged: () => void }) {
  const { client } = useAuth();
  const nav = useNavigation();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmBlock, setConfirmBlock] = useState(false);
  const { ogcId, relationship, pendingRequestId } = profile;

  async function run(kind: string, action: () => Promise<unknown>) {
    setBusy(kind);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const label = RELATIONSHIP_LABEL[relationship];
  return (
    <View style={social.card}>
      <View style={social.row}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={64} />
        <View style={social.names}>
          <Text style={social.name}>{profile.displayName}</Text>
          <Text style={social.ogcId}>{formatOgcIdForDisplay(ogcId)}</Text>
        </View>
      </View>
      {label ? <Text style={social.badge}>{label}</Text> : null}
      {profile.bio ? <Text style={social.body}>{profile.bio}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}
      {profile.canSendContactRequest ? (
        <Button
          title="Add contact"
          busy={busy === 'add'}
          onPress={() => void run('add', () => client.sendContactRequest(ogcId))}
        />
      ) : null}
      {relationship === 'NONE' && !profile.canSendContactRequest ? (
        <Text style={social.muted}>This person is not accepting contact requests.</Text>
      ) : null}
      {relationship === 'INCOMING_REQUEST' && pendingRequestId ? (
        <>
          <Button
            title="Accept"
            busy={busy === 'accept'}
            onPress={() => void run('accept', () => client.acceptRequest(pendingRequestId))}
          />
          <Button
            title="Decline"
            variant="secondary"
            busy={busy === 'decline'}
            onPress={() => void run('decline', () => client.declineRequest(pendingRequestId))}
          />
        </>
      ) : null}
      {relationship === 'OUTGOING_REQUEST' && pendingRequestId ? (
        <Button
          title="Cancel request"
          variant="secondary"
          busy={busy === 'cancel'}
          onPress={() => void run('cancel', () => client.cancelRequest(pendingRequestId))}
        />
      ) : null}
      {relationship === 'CONTACT' ? (
        <Button
          title="Remove contact"
          variant="secondary"
          busy={busy === 'remove'}
          onPress={() => void run('remove', () => client.removeContact(ogcId))}
        />
      ) : null}
      {relationship === 'BLOCKED' ? (
        <Button
          title="Unblock"
          variant="secondary"
          busy={busy === 'unblock'}
          onPress={() => void run('unblock', () => client.unblock(ogcId))}
        />
      ) : null}
      {relationship !== 'SELF' && relationship !== 'BLOCKED' ? (
        confirmBlock ? (
          <Button
            title="Confirm block"
            variant="ghost"
            busy={busy === 'block'}
            onPress={() => void run('block', () => client.block(ogcId))}
          />
        ) : (
          <Button
            title="Block"
            variant="ghost"
            onPress={() => {
              setConfirmBlock(true);
            }}
          />
        )
      ) : null}
      {relationship !== 'SELF' ? (
        <Button
          title="Report"
          variant="ghost"
          onPress={() => {
            nav.push({ name: 'report', ogcId });
          }}
        />
      ) : null}
    </View>
  );
}

export function DiscoverScreen() {
  const { client } = useAuth();
  const nav = useNavigation();
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [result, setResult] = useState<PublicProfile | 'not-found'>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function lookup(ogcId: string) {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await client.discover(ogcId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setResult('not-found');
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const parsed = ogcIdInputSchema.safeParse(input);
    if (!parsed.success) {
      setInputError(parsed.error.issues[0]?.message);
      return;
    }
    setInputError(undefined);
    void lookup(parsed.data);
  }

  return (
    <Screen title="Discover" onBack={nav.back}>
      <Field
        label="OGC ID"
        placeholder="OGC 482 731 905"
        value={input}
        onChangeText={setInput}
        autoCapitalize="characters"
        autoCorrect={false}
        error={inputError}
      />
      <Button title="Find" busy={busy} onPress={submit} />
      {error ? <Notice>{error}</Notice> : null}
      {result === 'not-found' ? (
        <Text style={social.empty}>No OGC account was found for that ID.</Text>
      ) : null}
      {result && result !== 'not-found' ? (
        <ProfileCard profile={result} onChanged={() => void lookup(result.ogcId)} />
      ) : null}
    </Screen>
  );
}

/** Opened from a deep link or a list. Shows the profile only; adding is always explicit. */
export function PublicProfileScreen({ ogcId }: { ogcId: string }) {
  const { client } = useAuth();
  const nav = useNavigation();
  const load = useCallback(() => client.publicProfile(ogcId), [client, ogcId]);
  const { state, reload } = useResource(load);
  return (
    <Screen title="OGC profile" onBack={nav.canGoBack ? nav.back : undefined}>
      {state.status === 'loading' ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {state.status === 'error' ? (
        <Text style={social.empty}>
          {state.error instanceof ApiError && state.error.status === 404
            ? 'This OGC profile is not available.'
            : errorMessage(state.error)}
        </Text>
      ) : null}
      {state.status === 'ready' ? <ProfileCard profile={state.data} onChanged={reload} /> : null}
    </Screen>
  );
}

function PersonRow({ profile, children }: { profile: ProfileSummary; children?: React.ReactNode }) {
  const nav = useNavigation();
  return (
    <View style={social.listItem}>
      <Pressable
        style={[social.row, { flex: 1 }]}
        accessibilityRole="button"
        onPress={() => {
          nav.push({ name: 'public-profile', ogcId: profile.ogcId });
        }}
      >
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={44} />
        <View style={social.names}>
          <Text style={social.menuText}>{profile.displayName}</Text>
          <Text style={social.ogcId}>{formatOgcIdForDisplay(profile.ogcId)}</Text>
        </View>
      </Pressable>
      {children}
    </View>
  );
}

type Tab = 'contacts' | 'incoming' | 'outgoing';

export function ContactsScreen() {
  const { client } = useAuth();
  const nav = useNavigation();
  const [tab, setTab] = useState<Tab>('contacts');
  const [error, setError] = useState<string>();
  const load = useCallback(
    (): Promise<Page<ContactView> | Page<ContactRequestView>> =>
      tab === 'contacts'
        ? client.contacts()
        : tab === 'incoming'
          ? client.incomingRequests()
          : client.outgoingRequests(),
    [client, tab],
  );
  const { state, reload } = useResource(load);

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
    reload();
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'contacts', label: 'Contacts' },
    { id: 'incoming', label: 'Requests' },
    { id: 'outgoing', label: 'Sent' },
  ];

  return (
    <Screen title="Contacts" onBack={nav.back}>
      <View style={social.tabs} accessibilityRole="tablist">
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
            style={[social.tab, tab === t.id && social.tabActive]}
            onPress={() => {
              setTab(t.id);
            }}
          >
            <Text style={[social.tabText, tab === t.id && social.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Notice>{error}</Notice> : null}
      {state.status === 'loading' ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {state.status === 'error' ? <Notice>{errorMessage(state.error)}</Notice> : null}
      {state.status === 'ready' && state.data.items.length === 0 ? (
        <Text style={social.empty}>
          {tab === 'contacts'
            ? 'No contacts yet. Find people by their OGC ID.'
            : 'Nothing pending.'}
        </Text>
      ) : null}
      {state.status === 'ready'
        ? state.data.items.map((item) =>
            'id' in item ? (
              <PersonRow key={item.id} profile={item.profile}>
                {tab === 'incoming' ? (
                  <View style={{ gap: 6 }}>
                    <Button
                      title="Accept"
                      onPress={() => void act(() => client.acceptRequest(item.id))}
                    />
                    <Button
                      title="Decline"
                      variant="ghost"
                      onPress={() => void act(() => client.declineRequest(item.id))}
                    />
                  </View>
                ) : (
                  <Button
                    title="Cancel"
                    variant="ghost"
                    onPress={() => void act(() => client.cancelRequest(item.id))}
                  />
                )}
              </PersonRow>
            ) : (
              <PersonRow key={item.profile.ogcId} profile={item.profile} />
            ),
          )
        : null}
    </Screen>
  );
}
