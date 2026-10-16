import type { OwnProfile } from '@ogc/types';
import { fontSize, fontWeight, radius, space } from '@ogc/ui';
import { BIO_MAX_LENGTH, updateProfileRequestSchema } from '@ogc/validation';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';
import { Avatar, OgcIdText, OgcQrCode, useCopy } from '../../components/identity';
import {
  Button,
  CountBadge,
  Field,
  ListGroup,
  ListRow,
  Loading,
  Notice,
  SectionHeader,
} from '../../components/ui';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { shareIdentity } from '../../lib/share';
import { useResource } from '../../lib/use-resource';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { color, themedStyles } from '../../theme';

function useOwnProfile() {
  const { client } = useAuth();
  const load = useCallback(() => client.profile(), [client]);
  return useResource(load);
}

/** "You": the user's profile, identity and every setting. */
export function ProfileScreen() {
  const { logout, state: auth } = useAuth();
  const nav = useNavigation();
  const { state, reload } = useOwnProfile();
  const { notificationsUnread } = useMessaging();
  const email = auth.status === 'signed-in' ? auth.account.email : '';

  if (state.status === 'loading') return <Loading label="Loading" />;
  if (state.status === 'error') {
    return (
      <Screen title="You">
        <Notice action={{ label: 'Retry', onPress: reload }}>{errorMessage(state.error)}</Notice>
        <Button title="Sign out" variant="ghost" icon="logout" onPress={() => void logout()} />
      </Screen>
    );
  }
  const profile = state.data;
  return (
    <Screen title="You">
      <View style={styles.profile}>
        <Avatar url={profile.avatarUrl} name={profile.displayName} size={72} ring />
        <View style={styles.profileText}>
          <Text style={styles.name} accessibilityRole="header" numberOfLines={2}>
            {profile.displayName}
          </Text>
          <OgcIdText ogcId={profile.ogcId} />
        </View>
      </View>
      {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
      <View style={styles.buttons}>
        <Button
          title="Edit profile"
          icon="edit"
          variant="secondary"
          compact
          style={styles.flex}
          onPress={() => {
            nav.push({ name: 'edit-profile' });
          }}
        />
        <Button
          title="Show my QR code"
          icon="qr"
          variant="secondary"
          compact
          style={styles.flex}
          onPress={() => {
            nav.push({ name: 'my-qr' });
          }}
        />
      </View>

      <SectionHeader title="Activity" />
      <ListGroup>
        <ListRow
          icon="bell"
          title="Notifications"
          accessibilityLabel={
            notificationsUnread > 0
              ? `Notifications, ${String(notificationsUnread)} new`
              : 'Notifications'
          }
          trailing={<CountBadge count={notificationsUnread} />}
          onPress={() => {
            nav.push({ name: 'notifications' });
          }}
        />
        <ListRow
          icon="settings"
          title="Notification settings"
          subtitle="Alerts, previews and quiet hours"
          onPress={() => {
            nav.push({ name: 'notification-settings' });
          }}
        />
        <ListRow
          icon="inbox"
          title="Group invitations"
          onPress={() => {
            nav.push({ name: 'invitations' });
          }}
        />
        <ListRow
          icon="userPlus"
          title="Discover people"
          subtitle="Find someone by their OGC ID"
          onPress={() => {
            nav.push({ name: 'discover' });
          }}
        />
      </ListGroup>

      <SectionHeader title="Appearance" />
      <ListGroup>
        <ListRow
          icon="palette"
          title="Appearance"
          subtitle="Obsidian, Ivory or System, and your accent colour"
          onPress={() => {
            nav.push({ name: 'appearance' });
          }}
        />
      </ListGroup>

      <SectionHeader title="Privacy and security" />
      <ListGroup>
        <ListRow
          icon="eye"
          title="Privacy"
          subtitle="Who can see your profile and contact you"
          onPress={() => {
            nav.push({ name: 'privacy' });
          }}
        />
        <ListRow
          icon="ban"
          title="Blocked people"
          onPress={() => {
            nav.push({ name: 'blocked' });
          }}
        />
        <ListRow
          icon="shieldCheck"
          title="Security and devices"
          subtitle="Signed-in devices, password and encryption"
          onPress={() => {
            nav.push({ name: 'security' });
          }}
        />
      </ListGroup>

      <SectionHeader title="Account" />
      <ListGroup>
        <ListRow icon="mail" title={email} subtitle="Private — never shown to others" />
        <ListRow
          icon="clock"
          title="Member since"
          subtitle={new Date(profile.memberSince).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        />
      </ListGroup>

      <Button title="Sign out" variant="danger" icon="logout" onPress={() => void logout()} />
    </Screen>
  );
}

/** Full-screen QR for someone to scan in person. */
export function MyQrScreen() {
  const nav = useNavigation();
  const { state } = useOwnProfile();
  const [copied, copy] = useCopy();
  return (
    <Screen title="My OGC QR" onBack={nav.back}>
      {state.status === 'ready' ? (
        <>
          <View style={styles.qrCard}>
            <Avatar url={state.data.avatarUrl} name={state.data.displayName} size={56} ring />
            <Text style={styles.qrName}>{state.data.displayName}</Text>
            <OgcQrCode ogcId={state.data.ogcId} size={232} />
            <OgcIdText ogcId={state.data.ogcId} size="lg" />
          </View>
          <View style={styles.qrNote}>
            <Icon name="shieldCheck" size={16} tint={color.accent} />
            <Text style={styles.qrNoteText}>
              Scanning shows your public profile. Nobody is added until they choose to send a
              request.
            </Text>
          </View>
          <View style={styles.buttons}>
            <Button
              title={copied ? 'Copied' : 'Copy ID'}
              icon={copied ? 'check' : 'copy'}
              variant="secondary"
              style={styles.flex}
              onPress={() => {
                copy(state.data.ogcId);
              }}
            />
            <Button
              title="Share my OGC"
              icon="share"
              style={styles.flex}
              onPress={() => void shareIdentity(state.data.ogcId, state.data.displayName)}
            />
          </View>
        </>
      ) : state.status === 'error' ? (
        <Notice>{errorMessage(state.error)}</Notice>
      ) : (
        <Loading label="Loading" />
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
      <View style={styles.photo}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose photo"
          disabled={busy === 'photo'}
          onPress={() => void choosePhoto()}
        >
          <Avatar
            url={profile.avatarUrl}
            name={displayName || profile.displayName}
            size={96}
            ring
          />
          <View style={styles.photoBadge}>
            <Icon name="image" size={16} tint={color.onAccent} />
          </View>
        </Pressable>
        <Button
          title="Choose photo"
          variant="ghost"
          compact
          busy={busy === 'photo'}
          onPress={() => void choosePhoto()}
        />
      </View>
      <Field
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        error={errors.displayName}
      />
      <Field
        label="About"
        multiline
        value={bio}
        onChangeText={setBio}
        maxLength={BIO_MAX_LENGTH * 2}
        error={errors.bio}
        hint={`${String(bio.trim().length)} / ${String(BIO_MAX_LENGTH)}`}
      />
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
      {state.status === 'loading' ? <Loading label="Loading" /> : null}
      {state.status === 'error' ? <Notice>{errorMessage(state.error)}</Notice> : null}
    </Screen>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    flex: { flex: 1 },
    profile: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
    profileText: { flex: 1, gap: space[1] },
    name: { color: color.textPrimary, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
    bio: { color: color.textSecondary, fontSize: fontSize.md, lineHeight: 22 },
    buttons: { flexDirection: 'row', gap: space[3] },
    qrCard: {
      alignItems: 'center',
      gap: space[4],
      padding: space[6],
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.xl,
    },
    qrName: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
    qrNote: { flexDirection: 'row', gap: space[2], alignItems: 'flex-start' },
    qrNoteText: { flex: 1, color: color.textMuted, fontSize: fontSize.sm, lineHeight: 20 },
    photo: { alignItems: 'center', gap: space[2] },
    photoBadge: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.accent,
      borderRadius: 16,
      borderWidth: 3,
      borderColor: color.background,
    },
  }),
);
