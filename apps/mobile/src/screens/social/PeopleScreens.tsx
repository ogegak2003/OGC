import type {
  ContactRequestView,
  ContactView,
  Page,
  ProfileSummary,
  PublicProfile,
} from '@ogc/types';
import { color, radius, space } from '@ogc/ui';
import { formatOgcIdForDisplay, ogcIdInputSchema } from '@ogc/validation';
import { type ReactNode, useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar, OgcIdText } from '../../components/identity';
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  ListGroup,
  ListRow,
  Loading,
  Notice,
  SkeletonRows,
  Tabs,
  Tag,
} from '../../components/ui';
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

const RELATIONSHIP_TONE: Record<
  PublicProfile['relationship'],
  'neutral' | 'accent' | 'success' | 'danger'
> = {
  SELF: 'accent',
  NONE: 'neutral',
  OUTGOING_REQUEST: 'neutral',
  INCOMING_REQUEST: 'accent',
  CONTACT: 'success',
  BLOCKED: 'danger',
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
    <View style={[social.card, styles.profileCard]}>
      <Avatar url={profile.avatarUrl} name={profile.displayName} size={88} />
      <View style={styles.identity}>
        <Text style={[social.name, styles.center]}>{profile.displayName}</Text>
        <OgcIdText ogcId={ogcId} />
      </View>
      {label ? <Tag label={label} tone={RELATIONSHIP_TONE[relationship]} /> : null}
      {profile.bio ? <Text style={[social.body, styles.center]}>{profile.bio}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}
      <View style={styles.actions}>
        {profile.canSendContactRequest ? (
          <Button
            title="Add contact"
            icon="userPlus"
            busy={busy === 'add'}
            onPress={() => void run('add', () => client.sendContactRequest(ogcId))}
          />
        ) : null}
        {relationship === 'NONE' && !profile.canSendContactRequest ? (
          <Text style={[social.muted, styles.center]}>
            This person is not accepting contact requests.
          </Text>
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
        <View style={styles.safety}>
          {relationship !== 'SELF' && relationship !== 'BLOCKED' ? (
            confirmBlock ? (
              <Button
                title="Confirm block"
                variant="danger"
                icon="ban"
                compact
                style={styles.flex}
                busy={busy === 'block'}
                onPress={() => void run('block', () => client.block(ogcId))}
              />
            ) : (
              <Button
                title="Block"
                variant="ghost"
                icon="ban"
                compact
                style={styles.flex}
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
              icon="flag"
              compact
              style={styles.flex}
              onPress={() => {
                nav.push({ name: 'report', ogcId });
              }}
            />
          ) : null}
        </View>
      </View>
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
    <Screen
      title="Discover"
      subtitle="Find someone by their exact OGC ID. Nobody can be found by phone number or email."
      onBack={nav.canGoBack ? nav.back : undefined}
    >
      <Field
        label="OGC ID"
        icon="search"
        placeholder="OGC 482 731 905"
        value={input}
        onChangeText={setInput}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={submit}
        error={inputError}
      />
      <Button title="Find" busy={busy} onPress={submit} />
      {error ? <Notice>{error}</Notice> : null}
      {result === 'not-found' ? (
        <EmptyState icon="user" title="No OGC account was found for that ID." />
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
      {state.status === 'loading' ? <Loading label="Loading" /> : null}
      {state.status === 'error' ? (
        <EmptyState
          icon="user"
          title={
            state.error instanceof ApiError && state.error.status === 404
              ? 'This OGC profile is not available.'
              : errorMessage(state.error)
          }
        />
      ) : null}
      {state.status === 'ready' ? <ProfileCard profile={state.data} onChanged={reload} /> : null}
    </Screen>
  );
}

function PersonRow({ profile, children }: { profile: ProfileSummary; children?: ReactNode }) {
  const nav = useNavigation();
  return (
    <ListRow
      title={profile.displayName}
      subtitle={formatOgcIdForDisplay(profile.ogcId)}
      leading={<Avatar url={profile.avatarUrl} name={profile.displayName} size={44} />}
      trailing={children}
      chevron={!children}
      accessibilityLabel={profile.displayName}
      onPress={() => {
        nav.push({ name: 'public-profile', ogcId: profile.ogcId });
      }}
    />
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
    { id: 'contacts', label: 'My contacts' },
    { id: 'incoming', label: 'Requests' },
    { id: 'outgoing', label: 'Sent' },
  ];

  return (
    <Screen
      title="Contacts"
      onBack={nav.canGoBack ? nav.back : undefined}
      actions={
        <IconButton
          icon="userPlus"
          label="Add a contact"
          tint={color.accent}
          onPress={() => {
            nav.push({ name: 'discover' });
          }}
        />
      }
    >
      <Tabs options={tabs} value={tab} onChange={setTab} />
      {error ? <Notice>{error}</Notice> : null}
      {state.status === 'loading' ? (
        <View style={styles.surface}>
          <SkeletonRows count={3} label="Loading" />
        </View>
      ) : null}
      {state.status === 'error' ? (
        <Notice action={{ label: 'Retry', onPress: reload }}>{errorMessage(state.error)}</Notice>
      ) : null}
      {state.status === 'ready' && state.data.items.length === 0 ? (
        tab === 'contacts' ? (
          <EmptyState
            icon="contacts"
            title="No contacts yet. Find people by their OGC ID."
            body="Ask someone for their OGC ID or QR code. Nobody is added without accepting."
            action={{
              label: 'Find someone',
              icon: 'userPlus',
              onPress: () => {
                nav.push({ name: 'discover' });
              },
            }}
          />
        ) : (
          <EmptyState icon="inbox" title="Nothing pending." />
        )
      ) : null}
      {state.status === 'ready' && state.data.items.length > 0 ? (
        <ListGroup>
          {state.data.items.map((item) =>
            'id' in item ? (
              <PersonRow key={item.id} profile={item.profile}>
                {tab === 'incoming' ? (
                  <View style={styles.requestActions}>
                    <Button
                      title="Decline"
                      variant="ghost"
                      compact
                      onPress={() => void act(() => client.declineRequest(item.id))}
                    />
                    <Button
                      title="Accept"
                      compact
                      onPress={() => void act(() => client.acceptRequest(item.id))}
                    />
                  </View>
                ) : (
                  <Button
                    title="Cancel"
                    variant="ghost"
                    compact
                    onPress={() => void act(() => client.cancelRequest(item.id))}
                  />
                )}
              </PersonRow>
            ) : (
              <PersonRow key={item.profile.ogcId} profile={item.profile} />
            ),
          )}
        </ListGroup>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  profileCard: { alignItems: 'center' },
  identity: { alignItems: 'center', gap: space[1] },
  center: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: space[3] },
  safety: { flexDirection: 'row', gap: space[2] },
  requestActions: { flexDirection: 'row', gap: space[1] },
  surface: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
});
