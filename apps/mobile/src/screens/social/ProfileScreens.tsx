import type { OwnProfile } from '@ogc/types';
import { BIO_MAX_LENGTH, formatOgcIdForDisplay, updateProfileRequestSchema } from '@ogc/validation';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar, OgcQrCode } from '../../components/identity';
import { Button, Field, Notice } from '../../components/ui';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { shareIdentity } from '../../lib/share';
import { useResource } from '../../lib/use-resource';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from './styles';

const MENU = [
  { label: 'Discover people', route: { name: 'discover' } },
  { label: 'Contacts', route: { name: 'contacts' } },
  { label: 'Privacy', route: { name: 'privacy' } },
  { label: 'Blocked people', route: { name: 'blocked' } },
] as const;

function useOwnProfile() {
  const { client } = useAuth();
  const load = useCallback(() => client.profile(), [client]);
  return useResource(load);
}

/** "My OGC": identity, sharing, and the way into every social feature. */
export function ProfileScreen() {
  const { logout } = useAuth();
  const nav = useNavigation();
  const { state } = useOwnProfile();

  if (state.status === 'loading')
    return <ActivityIndicator style={{ flex: 1 }} accessibilityLabel="Loading" />;
  if (state.status === 'error') {
    return (
      <Screen title="My OGC">
        <Notice>{errorMessage(state.error)}</Notice>
      </Screen>
    );
  }
  const profile = state.data;
  return (
    <Screen>
      <View style={social.row}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={64} />
        <View style={social.names}>
          <Text style={social.name} accessibilityRole="header">
            {profile.displayName}
          </Text>
          <Text
            style={social.muted}
            onPress={() => {
              nav.push({ name: 'edit-profile' });
            }}
            accessibilityRole="button"
          >
            Edit profile
          </Text>
        </View>
      </View>
      <View style={social.card}>
        <Text style={social.label}>YOUR OGC ID</Text>
        <Text style={social.bigOgcId} accessibilityLabel={profile.ogcId} selectable>
          {formatOgcIdForDisplay(profile.ogcId)}
        </Text>
        {profile.bio ? <Text style={social.body}>{profile.bio}</Text> : null}
        <Button
          title="Share my OGC"
          onPress={() => void shareIdentity(profile.ogcId, profile.displayName)}
        />
        <Button
          title="Show my QR code"
          variant="secondary"
          onPress={() => {
            nav.push({ name: 'my-qr' });
          }}
        />
      </View>
      <View>
        {MENU.map((item) => (
          <Text
            key={item.label}
            style={[social.menuItem, social.menuText]}
            accessibilityRole="button"
            onPress={() => {
              nav.push(item.route);
            }}
          >
            {item.label}
          </Text>
        ))}
      </View>
      <Button title="Sign out" variant="ghost" onPress={() => void logout()} />
    </Screen>
  );
}

/** Full-screen QR for someone to scan in person. */
export function MyQrScreen() {
  const nav = useNavigation();
  const { state } = useOwnProfile();
  return (
    <Screen title="My OGC QR" onBack={nav.back}>
      {state.status === 'ready' ? (
        <>
          <OgcQrCode ogcId={state.data.ogcId} size={260} />
          <Text style={[social.bigOgcId, { textAlign: 'center' }]}>
            {formatOgcIdForDisplay(state.data.ogcId)}
          </Text>
          <Text style={[social.muted, { textAlign: 'center' }]}>
            Scanning shows your public profile. Nobody is added until they choose to send a request.
          </Text>
          <Button
            title="Share my OGC"
            onPress={() => void shareIdentity(state.data.ogcId, state.data.displayName)}
          />
        </>
      ) : (
        <ActivityIndicator accessibilityLabel="Loading" />
      )}
    </Screen>
  );
}

function EditForm({ initial }: { initial: OwnProfile }) {
  const { client } = useAuth();
  const nav = useNavigation();
  const [profile, setProfile] = useState(initial);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [bio, setBio] = useState(initial.bio ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState<'save' | 'photo'>();

  async function save() {
    const parsed = updateProfileRequestSchema.safeParse({ displayName, bio });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy('save');
    try {
      await client.updateProfile({ displayName, bio });
      nav.back();
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function choosePhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setBusy('photo');
    try {
      setProfile(
        await client.uploadAvatar({ uri: asset.uri, mimeType: asset.mimeType ?? 'image/jpeg' }),
      );
      setNotice({ tone: 'success', text: 'Profile photo updated.' });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <View style={social.row}>
        <Avatar url={profile.avatarUrl} name={displayName || profile.displayName} size={72} />
        <View style={social.names}>
          <Button
            title="Choose photo"
            variant="secondary"
            busy={busy === 'photo'}
            onPress={() => void choosePhoto()}
          />
        </View>
      </View>
      <Field
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        error={errors.displayName}
      />
      <Text style={social.muted}>About</Text>
      <TextInput
        accessibilityLabel="About"
        style={social.input}
        multiline
        value={bio}
        onChangeText={setBio}
        maxLength={BIO_MAX_LENGTH * 2}
      />
      <Text style={social.muted}>{errors.bio ?? `${bio.trim().length} / ${BIO_MAX_LENGTH}`}</Text>
      <Button title="Save profile" busy={busy === 'save'} onPress={() => void save()} />
    </>
  );
}

export function EditProfileScreen() {
  const nav = useNavigation();
  const { state } = useOwnProfile();
  return (
    <Screen title="Edit profile" onBack={nav.back}>
      {state.status === 'ready' ? <EditForm initial={state.data} /> : null}
      {state.status === 'loading' ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {state.status === 'error' ? <Notice>{errorMessage(state.error)}</Notice> : null}
    </Screen>
  );
}
