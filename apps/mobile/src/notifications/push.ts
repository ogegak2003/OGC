import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { ApiClient } from '../api/client';

/**
 * Remote push on this device (Phase 7, ADR-038). Expo push tokens need a development or
 * release build: Expo Go cannot receive remote notifications for OGC's project (Expo SDK 53
 * removed remote push from Expo Go on Android). Android also needs Firebase credentials in the
 * build, and iOS an APNs key; see docs/development/notifications.md.
 */

export type PushSupport = 'supported' | 'expo-go' | 'unsupported-platform';
export type PushPermission = 'granted' | 'denied' | 'undetermined';

export function pushSupport(): PushSupport {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return 'unsupported-platform';
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return 'expo-go';
  return 'supported';
}

/**
 * Android notification channels, matching what the server picks (push-provider.ts
 * `androidChannel`). Channel sound/vibration cannot change after creation, so each
 * combination is its own channel; people can still adjust them in system settings.
 */
export const ANDROID_CHANNELS: {
  id: string;
  name: string;
  sound: boolean;
  vibration: boolean;
  importance: Notifications.AndroidImportance;
}[] = [
  {
    id: 'ogc-alerts',
    name: 'Messages and alerts',
    sound: true,
    vibration: true,
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'ogc-sound',
    name: 'Alerts with sound only',
    sound: true,
    vibration: false,
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'ogc-vibrate',
    name: 'Alerts with vibration only',
    sound: false,
    vibration: true,
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'ogc-silent',
    name: 'Silent alerts (quiet hours)',
    sound: false,
    vibration: false,
    importance: Notifications.AndroidImportance.LOW,
  },
  {
    id: 'ogc-calls',
    name: 'Calls',
    sound: true,
    vibration: true,
    importance: Notifications.AndroidImportance.MAX,
  },
];

async function createChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const channel of ANDROID_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance: channel.importance,
      sound: channel.sound ? 'default' : null,
      enableVibrate: channel.vibration,
      ...(channel.vibration ? { vibrationPattern: [0, 250, 200, 250] } : {}),
      showBadge: true,
    });
  }
}

function toPermission(status: Notifications.PermissionStatus): PushPermission {
  if (status === Notifications.PermissionStatus.GRANTED) return 'granted';
  if (status === Notifications.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}

export async function pushPermission(): Promise<PushPermission> {
  if (pushSupport() !== 'supported') return 'denied';
  const { status } = await Notifications.getPermissionsAsync();
  return toPermission(status);
}

/** Asks the system once (later calls return the stored answer without a prompt). */
export async function requestPushPermission(): Promise<PushPermission> {
  if (pushSupport() !== 'supported') return 'denied';
  await createChannels();
  const { status } = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return toPermission(status);
}

export type RegisterResult =
  | { status: 'registered'; token: string }
  | { status: 'unchanged' }
  | { status: 'permission-denied' | 'permission-undetermined' | 'expo-go' | 'unsupported-platform' }
  | { status: 'error'; reason: string };

/** Tokens registered in this app run, per account (the server upsert is idempotent anyway). */
const registered = new Map<string, string>();

/**
 * Gets this installation's Expo push token and registers it with OGC for the signed-in
 * device. Asks for permission only when `prompt` is set and the person has not answered yet.
 * Never throws: a missing permission or credential leaves the app fully usable.
 */
export async function registerForPush(
  client: Pick<ApiClient, 'registerPushToken'>,
  account: string,
  { prompt }: { prompt: boolean },
): Promise<RegisterResult> {
  const support = pushSupport();
  if (support !== 'supported') return { status: support };
  try {
    await createChannels();
    let permission = await pushPermission();
    if (permission === 'undetermined' && prompt) permission = await requestPushPermission();
    if (permission !== 'granted') {
      return { status: permission === 'denied' ? 'permission-denied' : 'permission-undetermined' };
    }
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId;
    if (!projectId) return { status: 'error', reason: 'missing-project-id' };
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (registered.get(account) === token) return { status: 'unchanged' };
    await client.registerPushToken(token);
    registered.set(account, token);
    return { status: 'registered', token };
  } catch (error) {
    // Typically missing Firebase (Android) or APNs (iOS) credentials in this build.
    return { status: 'error', reason: error instanceof Error ? error.message : 'unknown' };
  }
}

/** Forgets the token cached for an account (after sign-out, the server already removed it). */
export function forgetPushRegistration(account: string): void {
  registered.delete(account);
}
