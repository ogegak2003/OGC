import type { NotificationSettingsView } from '@ogc/types';
import type { NotificationSettingsUpdate } from '@ogc/validation';
import { color, fontSize, fontWeight, radius, space } from '@ogc/ui';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';
import {
  Button,
  ListGroup,
  Notice,
  SectionHeader,
  SkeletonRows,
  SwitchRow,
  Tabs,
} from '../../components/ui';
import { useResource } from '../../lib/use-resource';
import { useNavigation } from '../../navigation';
import {
  type PushPermission,
  pushPermission,
  pushSupport,
  registerForPush,
  requestPushPermission,
} from '../../notifications/push';
import { Screen } from '../Screen';

const STEP = 30;

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A time of day adjusted in 30-minute steps (accessible as an adjustable control). */
function TimeStepper({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (minute: number) => void;
  disabled: boolean;
}) {
  const shift = (delta: number) => {
    onChange((value + delta + 1440) % 1440);
  };
  return (
    <View
      style={styles.stepper}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: formatMinute(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        shift(event.nativeEvent.actionName === 'increment' ? STEP : -STEP);
      }}
    >
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <Pressable
          accessibilityLabel={`${label} earlier`}
          disabled={disabled}
          onPress={() => {
            shift(-STEP);
          }}
          style={styles.stepButton}
          hitSlop={6}
        >
          <Icon name="back" size={18} tint={color.accent} />
        </Pressable>
        <Text style={styles.stepperValue}>{formatMinute(value)}</Text>
        <Pressable
          accessibilityLabel={`${label} later`}
          disabled={disabled}
          onPress={() => {
            shift(STEP);
          }}
          style={styles.stepButton}
          hitSlop={6}
        >
          <Icon name="chevronRight" size={18} tint={color.accent} />
        </Pressable>
      </View>
    </View>
  );
}

/** Push notifications: this device's permission, and the account's preferences (all devices). */
export function NotificationSettingsScreen() {
  const nav = useNavigation();
  const { client, state: auth } = useAuth();
  const load = useCallback(() => client.notificationSettings(), [client]);
  const { state, reload } = useResource(load);
  // Local edits over the loaded settings (what the screen shows while a save is in flight).
  const [edited, setSettings] = useState<NotificationSettingsView>();
  const settings = edited ?? (state.status === 'ready' ? state.data : undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [permission, setPermission] = useState<PushPermission>();
  const support = pushSupport();
  const account = auth.status === 'signed-in' ? auth.account.ogcId : undefined;

  // The permission can change in system settings while OGC is in the background.
  useEffect(() => {
    void pushPermission().then(setPermission);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void pushPermission().then(setPermission);
    });
    return () => {
      sub.remove();
    };
  }, []);

  /** Saves a change; the screen shows it at once and reverts if the server refuses it. */
  const save = (update: NotificationSettingsUpdate, optimistic: NotificationSettingsView) => {
    const previous = settings;
    setSettings(optimistic);
    setSaving(true);
    setError(undefined);
    client.updateNotificationSettings(update).then(
      (saved) => {
        setSettings(saved);
        setSaving(false);
      },
      () => {
        setSettings(previous);
        setSaving(false);
        setError(
          'Your notification settings could not be saved. Check your connection and try again.',
        );
      },
    );
  };

  const allow = async () => {
    const result = await requestPushPermission();
    setPermission(result);
    if (result === 'granted' && account) await registerForPush(client, account, { prompt: false });
  };

  const toggle =
    (
      key:
        | 'enabled'
        | 'messages'
        | 'groups'
        | 'channels'
        | 'contactRequests'
        | 'calls'
        | 'sound'
        | 'vibration',
    ) =>
    (value: boolean) => {
      if (!settings) return;
      save({ [key]: value }, { ...settings, [key]: value });
    };

  const setQuiet = (patch: Partial<NotificationSettingsView['quietHours']>) => {
    if (!settings) return;
    const next = { ...settings.quietHours, ...patch, timeZone: deviceTimeZone() };
    if (next.start === next.end) next.end = (next.end + STEP) % 1440;
    save({ quietHours: next }, { ...settings, quietHours: next });
  };

  const off = !settings?.enabled;

  return (
    <Screen
      title="Notifications"
      subtitle="Alerts for messages, calls and requests. Message text is never sent in a notification."
      onBack={nav.back}
    >
      <SectionHeader title="This device" />
      {support === 'expo-go' ? (
        <Notice tone="warning">
          Push notifications need the OGC app build. Expo Go can’t receive them for OGC; your
          settings below still apply to your other devices.
        </Notice>
      ) : support === 'unsupported-platform' ? (
        <Notice tone="info">Push notifications aren’t available on this platform.</Notice>
      ) : permission === 'granted' ? (
        <View style={styles.status}>
          <Icon name="check" size={18} tint={color.success} />
          <Text style={styles.statusText}>Notifications are allowed on this device.</Text>
        </View>
      ) : permission === 'denied' ? (
        <View style={styles.permission}>
          <Text style={styles.statusText}>
            Notifications are turned off for OGC in your system settings. Turn them on there to get
            alerts when OGC is closed.
          </Text>
          <Button
            title="Open system settings"
            variant="secondary"
            onPress={() => void Linking.openSettings()}
          />
        </View>
      ) : permission === 'undetermined' ? (
        <View style={styles.permission}>
          <Text style={styles.statusText}>
            Allow notifications to hear about new messages and calls when OGC is closed.
          </Text>
          <Button title="Allow notifications" onPress={() => void allow()} />
        </View>
      ) : null}

      <SectionHeader title="Your account (all devices)" />
      {error ? <Notice tone="warning">{error}</Notice> : null}
      {state.status === 'error' ? (
        <Notice action={{ label: 'Retry', onPress: reload }}>
          Your notification settings could not be loaded.
        </Notice>
      ) : !settings ? (
        <View style={styles.surface}>
          <SkeletonRows count={4} label="Loading notification settings" />
        </View>
      ) : (
        <>
          <ListGroup>
            <SwitchRow
              label="Push notifications"
              description="Off: nothing is pushed; you still see everything when you open OGC."
              value={settings.enabled}
              onValueChange={toggle('enabled')}
            />
          </ListGroup>
          <ListGroup>
            <SwitchRow
              label="Direct messages"
              value={settings.messages}
              disabled={off}
              onValueChange={toggle('messages')}
            />
            <SwitchRow
              label="Groups"
              description="Group messages, mentions and invitations"
              value={settings.groups}
              disabled={off}
              onValueChange={toggle('groups')}
            />
            <SwitchRow
              label="Channels"
              description="Announcements and channel updates"
              value={settings.channels}
              disabled={off}
              onValueChange={toggle('channels')}
            />
            <SwitchRow
              label="Contact requests"
              value={settings.contactRequests}
              disabled={off}
              onValueChange={toggle('contactRequests')}
            />
            <SwitchRow
              label="Calls"
              description="Incoming and missed calls"
              value={settings.calls}
              disabled={off}
              onValueChange={toggle('calls')}
            />
          </ListGroup>

          <Text style={styles.groupTitle}>Preview</Text>
          <Tabs
            options={[
              { id: 'GENERIC', label: 'Private' },
              { id: 'SENDER', label: 'Show sender' },
            ]}
            value={settings.preview}
            onChange={(preview) => {
              save({ preview }, { ...settings, preview });
            }}
          />
          <Text style={styles.help}>
            {settings.preview === 'GENERIC'
              ? 'Notifications say only “OGC — New message”. Nothing about who wrote is shared with Apple, Google or Expo.'
              : 'Notifications show who wrote (and the group name). Names pass through Apple, Google and Expo’s push services. Message text is never included.'}
          </Text>

          <ListGroup>
            <SwitchRow
              label="Sound"
              value={settings.sound}
              disabled={off}
              onValueChange={toggle('sound')}
            />
            <SwitchRow
              label="Vibration"
              value={settings.vibration}
              disabled={off}
              onValueChange={toggle('vibration')}
            />
          </ListGroup>

          <ListGroup>
            <SwitchRow
              label="Quiet hours"
              description="Notifications arrive silently, without sound or vibration."
              value={settings.quietHours.enabled}
              disabled={off}
              onValueChange={(enabled) => {
                setQuiet({ enabled });
              }}
            />
          </ListGroup>
          {settings.quietHours.enabled ? (
            <View style={styles.quiet}>
              <TimeStepper
                label="From"
                value={settings.quietHours.start}
                disabled={off || saving}
                onChange={(start) => {
                  setQuiet({ start });
                }}
              />
              <TimeStepper
                label="Until"
                value={settings.quietHours.end}
                disabled={off || saving}
                onChange={(end) => {
                  setQuiet({ end });
                }}
              />
              <Text style={styles.help}>Time zone: {settings.quietHours.timeZone}</Text>
            </View>
          ) : null}
          <Text style={styles.help}>
            To mute one chat or group, open it and change its notification settings.
          </Text>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  surface: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  statusText: { flex: 1, color: color.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
  permission: { gap: space[3] },
  groupTitle: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  help: { color: color.textMuted, fontSize: fontSize.sm, lineHeight: 20 },
  quiet: {
    gap: space[3],
    padding: space[4],
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperLabel: { color: color.textPrimary, fontSize: fontSize.md },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  stepButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: 20,
  },
  stepperValue: {
    minWidth: 56,
    color: color.textPrimary,
    fontSize: fontSize.lg,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
});
