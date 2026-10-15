import type { DeviceSessionView } from '@ogc/types';
import { changePasswordRequestSchema } from '@ogc/validation';
import { color, fontSize } from '@ogc/ui';
import { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import {
  Button,
  Field,
  ListGroup,
  ListRow,
  Loading,
  Notice,
  SectionHeader,
  Tag,
} from '../../components/ui';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { useResource } from '../../lib/use-resource';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';

const THIS_PLATFORM =
  Platform.OS === 'ios' ? 'iPhone or iPad' : Platform.OS === 'android' ? 'Android' : 'This device';

const PLATFORM: Record<DeviceSessionView['platform'], string> = {
  WEB: 'Web browser',
  IOS: 'iPhone or iPad',
  ANDROID: 'Android',
  DESKTOP: 'Desktop app',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface Message {
  tone: 'error' | 'success';
  text: string;
}

/** Other signed-in devices: sign out a lost one, or every other one. */
function OtherDevices() {
  const { client } = useAuth();
  const load = useCallback(() => client.sessions(), [client]);
  const { state, reload } = useResource(load);
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState<string>();

  const run = (key: string, task: () => Promise<string>) => {
    setMessage(undefined);
    setBusy(key);
    task().then(
      (text) => {
        setBusy(undefined);
        setMessage({ tone: 'success', text });
        reload();
      },
      (cause: unknown) => {
        setBusy(undefined);
        setMessage({ tone: 'error', text: errorMessage(cause) });
      },
    );
  };

  if (state.status === 'loading') return <Loading label="Loading devices" />;
  if (state.status === 'error') return <Notice>{errorMessage(state.error)}</Notice>;
  const others = state.data.filter((s) => !s.current);
  return (
    <>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {others.length === 0 ? (
        <Text style={styles.body}>You are not signed in anywhere else.</Text>
      ) : (
        <ListGroup>
          {others.map((s) => {
            const name = s.deviceName ?? PLATFORM[s.platform];
            return (
              <ListRow
                key={s.id}
                icon="device"
                title={name}
                subtitle={`Last active ${when(s.lastUsedAt)}`}
                trailing={
                  <Button
                    title="Sign out"
                    variant="secondary"
                    compact
                    busy={busy === s.id}
                    accessibilityLabel={`Sign out ${name}`}
                    onPress={() => {
                      run(s.id, async () => {
                        await client.revokeSession(s.id);
                        return `${name} was signed out.`;
                      });
                    }}
                  />
                }
              />
            );
          })}
        </ListGroup>
      )}
      {others.length > 0 ? (
        <Button
          title="Sign out all other devices"
          variant="danger"
          busy={busy === 'others'}
          onPress={() => {
            run('others', async () => {
              const { ended } = await client.revokeOtherSessions();
              return `Signed out ${String(ended)} other ${ended === 1 ? 'device' : 'devices'}.`;
            });
          }}
        />
      ) : null}
    </>
  );
}

function ChangePassword() {
  const { client } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setMessage(undefined);
    const parsed = changePasswordRequestSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    client.changePassword(parsed.data).then(
      ({ otherSessionsEnded }) => {
        setBusy(false);
        setCurrentPassword('');
        setNewPassword('');
        setMessage({
          tone: 'success',
          text:
            otherSessionsEnded > 0
              ? `Password changed. ${String(otherSessionsEnded)} other ${otherSessionsEnded === 1 ? 'device was' : 'devices were'} signed out.`
              : 'Password changed.',
        });
      },
      (cause: unknown) => {
        setBusy(false);
        setMessage({ tone: 'error', text: errorMessage(cause) });
      },
    );
  };

  return (
    <>
      <Text style={styles.body}>
        Every other device is signed out when you change your password. Use at least 12 characters;
        a few unrelated words work well.
      </Text>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Field
        label="Current password"
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        value={currentPassword}
        onChangeText={setCurrentPassword}
        error={errors.currentPassword}
      />
      <Field
        label="New password"
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        value={newPassword}
        onChangeText={setNewPassword}
        error={errors.newPassword}
      />
      <Button title="Change password" busy={busy} onPress={submit} />
    </>
  );
}

/** Account security: this device, other signed-in devices, and the password. */
export function SecurityScreen() {
  const nav = useNavigation();
  const { logout, state } = useAuth();
  const { status, engine } = useMessaging();
  const email = state.status === 'signed-in' ? state.account.email : '';
  const encryption =
    status === 'ready'
      ? 'Ready — messages on this device are sealed with a key in its secure keystore'
      : status === 'error'
        ? 'Could not start on this device'
        : 'Setting up…';

  return (
    <Screen
      title="Security and devices"
      subtitle="How your account and messages are protected."
      onBack={nav.back}
    >
      <SectionHeader title="This device" />
      <ListGroup>
        <ListRow
          icon="device"
          title={THIS_PLATFORM}
          subtitle={`Signed in as ${email}`}
          trailing={<Tag label="Current" tone="success" />}
        />
        <ListRow
          icon="lock"
          title="End-to-end encryption"
          subtitle={encryption}
          tone={status === 'error' ? 'danger' : 'default'}
        />
        {engine ? <ListRow icon="key" title="Device key" subtitle={engine.deviceKeyId} /> : null}
      </ListGroup>

      <SectionHeader title="Other devices" />
      <Text style={styles.body}>
        Sign out a device you no longer use or have lost. It loses access immediately, and its
        encryption keys and notifications are removed.
      </Text>
      <OtherDevices />

      <SectionHeader title="Change password" />
      <ChangePassword />

      <SectionHeader title="Verify conversations" />
      <Text style={styles.body}>
        In any direct conversation, tap the shield to compare safety numbers with the other person.
        If they match, messages are encrypted only for your and their devices. You are warned when
        their security keys change.
      </Text>

      <Button
        title="Sign out of this device"
        variant="danger"
        icon="logout"
        onPress={() => void logout()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { color: color.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
});
