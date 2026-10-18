import type {
  ContactRequestView,
  ContactView,
  Page,
  ProfileSummary,
  PublicProfile,
} from '@ogc/types';
import { radius, space } from '@ogc/ui';
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
import { ErrorState } from '../../components/ErrorState';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from './styles';
import { color, themedStyles } from '../../theme';

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

type Sensitive = 'remove' | 'cancel' | 'unblock' | 'block';

const CONFIRM: Record<Sensitive, { label: string; detail: string; danger: boolean }> = {
  remove: {
    label: 'Remove contact',
    detail: 'You will need a new contact request to reconnect.',
    danger: true,
  },
  cancel: {
    label: 'Cancel request',
    detail: 'They will no longer see your contact request.',
    danger: false,
  },
  unblock: {
    label: 'Unblock',
    detail: 'They can find you and send a contact request again. They are not added back.',
    danger: false,
  },
  block: {
    label: 'Confirm block',
    detail: 'They can’t message or call you, see your profile, or find you. They are not told.',
    danger: true,
  },
};

/** A profile with the actions its relationship allows; re-reads from the server after each action. */
function ProfileCard({ profile, onChanged }: { profile: PublicProfile; onChanged: () => void }) {
  const { client } = useAuth();
  const { engine } = useMessaging();
  const nav = useNavigation();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<Sensitive>();
  const { ogcId, relationship, pendingRequestId } = profile;

  async function run(kind: string, action: () => Promise<unknown>) {
    setBusy(kind);
    setError(undefined);
    try {
      await action();
      setConfirming(undefined);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  function perform(kind: Sensitive) {
    if (kind === 'remove') void run(kind, () => client.removeContact(ogcId));
    if (kind === 'unblock') void run(kind, () => client.unblock(ogcId));
    if (kind === 'block') void run(kind, () => client.block(ogcId));
    if (kind === 'cancel' && pendingRequestId) {
      void run(kind, () => client.cancelRequest(pendingRequestId));
    }
  }

  function message() {
    if (!engine) return;
    setBusy('message');
    engine.openDirect(ogcId).then(
      (conversation) => {
        setBusy(undefined);
        nav.push({ name: 'conversation', conversationId: conversation.id });
      },
      () => {
        setBusy(undefined);
        setError('This conversation could not be opened.');
      },
    );
  }

  const label = RELATIONSHIP_LABEL[relationship];
  const pending = confirming ? CONFIRM[confirming] : undefined;
  return (
    <View style={[social.card, styles.profileCard]}>
      <View style={styles.band} />
      <View style={styles.avatarRing}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={88} />
      </View>
      <View style={styles.identity}>
        <Text style={[social.name, styles.center]}>{profile.displayName}</Text>
        <OgcIdText ogcId={ogcId} />
      </View>
      {label ? <Tag label={label} tone={RELATIONSHIP_TONE[relationship]} /> : null}
      {profile.bio ? <Text style={[social.body, styles.center]}>{profile.bio}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}
      {confirming && pending ? (
        <View style={styles.confirm} accessibilityRole="alert">
          <Text style={social.body}>{pending.detail}</Text>
          <View style={styles.safety}>
            <Button
              title="Keep"
              variant="secondary"
              compact
              style={styles.flex}
              onPress={() => {
                setConfirming(undefined);
              }}
            />
            <Button
              title={pending.label}
              variant={pending.danger ? 'danger' : 'primary'}
              compact
              style={styles.flex}
              busy={busy === confirming}
              onPress={() => {
                perform(confirming);
              }}
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          {relationship === 'CONTACT' && engine ? (
            <Button title="Message" icon="chat" busy={busy === 'message'} onPress={message} />
          ) : null}
          {relationship === 'SELF' ? (
            <Button
              title="Edit your profile"
              icon="edit"
              variant="secondary"
              onPress={() => {
                nav.push({ name: 'edit-profile' });
              }}
            />
          ) : null}
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
            <View style={styles.safety}>
              <Button
                title="Decline"
                variant="secondary"
                style={styles.flex}
                busy={busy === 'decline'}
                onPress={() => void run('decline', () => client.declineRequest(pendingRequestId))}
              />
              <Button
                title="Accept"
                style={styles.flex}
                busy={busy === 'accept'}
                onPress={() => void run('accept', () => client.acceptRequest(pendingRequestId))}
              />
            </View>
          ) : null}
          {relationship === 'OUTGOING_REQUEST' && pendingRequestId ? (
            <Button
              title="Cancel request"
              variant="secondary"
              onPress={() => {
                setConfirming('cancel');
              }}
            />
          ) : null}
          {relationship === 'CONTACT' ? (
            <Button
              title="Remove contact"
              variant="secondary"
              onPress={() => {
                setConfirming('remove');
              }}
            />
          ) : null}
          {relationship === 'BLOCKED' ? (
            <Button
              title="Unblock"
              variant="secondary"
              onPress={() => {
                setConfirming('unblock');
              }}
            />
          ) : null}
          {relationship !== 'SELF' ? (
            <View style={[styles.safety, styles.safetyRow]}>
              {relationship !== 'BLOCKED' ? (
                <Button
                  title="Block"
                  variant="ghost"
                  icon="ban"
                  compact
                  style={styles.flex}
                  onPress={() => {
                    setConfirming('block');
                  }}
                />
              ) : null}
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
            </View>
          ) : null}
        </View>
      )}
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
      {state.status === 'error' &&
      state.error instanceof ApiError &&
      (state.error.status === 404 || state.error.status === 400) ? (
        <ErrorState kind="not-found" title="Profile not available">
          This OGC profile is not available. The link may be wrong, or the account may not be
          visible to you.
        </ErrorState>
      ) : state.status === 'error' &&
        state.error instanceof ApiError &&
        state.error.status === 403 ? (
        <ErrorState kind="forbidden" title="You can’t view this profile" />
      ) : state.status === 'error' ? (
        <EmptyState icon="user" title={errorMessage(state.error)} />
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

/** Filters the loaded list by name or OGC ID (spaces ignored); it never queries the server. */
function matches(profile: ProfileSummary, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  if (!query) return true;
  return (
    profile.displayName.toLowerCase().includes(query) ||
    profile.ogcId.toLowerCase().includes(query.replace(/\s+/g, ''))
  );
}

export function ContactsScreen({ initialTab = 'contacts' }: { initialTab?: Tab }) {
  const { client } = useAuth();
  const nav = useNavigation();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');
  const [cancelling, setCancelling] = useState<string>();
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
      {state.status === 'ready' && tab === 'contacts' && state.data.items.length > 5 ? (
        <Field
          label="Filter contacts"
          icon="search"
          placeholder="Name or OGC ID"
          value={filter}
          onChangeText={setFilter}
          autoCorrect={false}
        />
      ) : null}
      {state.status === 'ready' && state.data.items.length > 0 ? (
        <ListGroup>
          {state.data.items
            .filter((item) => tab !== 'contacts' || matches(item.profile, filter))
            .map((item) =>
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
                  ) : cancelling === item.id ? (
                    <View style={styles.requestActions}>
                      <Button
                        title="Keep"
                        variant="ghost"
                        compact
                        onPress={() => {
                          setCancelling(undefined);
                        }}
                      />
                      <Button
                        title="Cancel request"
                        variant="danger"
                        compact
                        onPress={() => {
                          setCancelling(undefined);
                          void act(() => client.cancelRequest(item.id));
                        }}
                      />
                    </View>
                  ) : (
                    <Button
                      title="Cancel"
                      variant="ghost"
                      compact
                      onPress={() => {
                        setCancelling(item.id);
                      }}
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

const styles = themedStyles(() =>
  StyleSheet.create({
    flex: { flex: 1 },
    profileCard: { alignItems: 'center', overflow: 'hidden', paddingTop: 0 },
    band: {
      alignSelf: 'stretch',
      height: 64,
      marginHorizontal: -space[5],
      marginBottom: -56,
      backgroundColor: color.accentSubtle,
      borderBottomWidth: 1,
      borderBottomColor: color.accentBorder,
    },
    avatarRing: { padding: 4, borderRadius: radius.full, backgroundColor: color.surface },
    confirm: {
      alignSelf: 'stretch',
      gap: space[3],
      padding: space[4],
      backgroundColor: color.surfaceRaised,
      borderRadius: radius.md,
    },
    safetyRow: {
      paddingTop: space[2],
      borderTopWidth: 1,
      borderTopColor: color.border,
    },
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
  }),
);
