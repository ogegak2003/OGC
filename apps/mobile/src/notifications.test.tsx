import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AccountView, NotificationSettingsView, OgcId, OwnProfile } from '@ogc/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { forgetPushRegistration, registerForPush } from './notifications/push';
import { routeForPush } from './notifications/routing';
import { FakeEngine, conversationView, fakeMessaging } from './test/fake-messaging';

/*
 * Push notifications on mobile with a MOCKED expo-notifications module (jest.setup.js): these
 * tests cover registration logic, settings and tap routing — not delivery to a real device.
 */

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
// A plain, writable copy of expo-constants with the EAS project ID from app.config.ts (Jest does
// not load the app config) and a development-build environment (tests switch to Expo Go).
jest.mock('expo-constants', () => {
  const actual = jest.requireActual<{ default: object }>('expo-constants');
  return {
    ...actual,
    __esModule: true,
    default: {
      ...actual.default,
      executionEnvironment: 'bare',
      expoConfig: { extra: { eas: { projectId: '20ebd5df-819e-4aa6-a904-bd10969bae5f' } } },
    },
  };
});

const mocked = Notifications as unknown as {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
  getLastNotificationResponse: jest.Mock;
};
const CONVERSATION = conversationView();

beforeEach(() => {
  forgetPushRegistration('OGC306841127');
  mocked.getPermissionsAsync.mockImplementation(() =>
    Promise.resolve({ status: 'undetermined', granted: false }),
  );
  mocked.requestPermissionsAsync.mockImplementation(() =>
    Promise.resolve({ status: 'denied', granted: false }),
  );
  mocked.getLastNotificationResponse.mockImplementation(() => null);
});

describe('notification tap routing', () => {
  it('opens the conversation of a message or call', () => {
    expect(routeForPush({ type: 'message', conversationId: CONVERSATION.id })).toEqual({
      route: { name: 'conversation', conversationId: CONVERSATION.id },
    });
    expect(routeForPush({ type: 'call', callId: 'x', conversationId: CONVERSATION.id })).toEqual({
      route: { name: 'conversation', conversationId: CONVERSATION.id },
    });
  });

  it('opens invitations, notifications and contacts for the other kinds', () => {
    expect(routeForPush({ type: 'community', notification: 'GROUP_INVITATION' })).toEqual({
      route: { name: 'invitations' },
    });
    expect(routeForPush({ type: 'community', notification: 'MENTION' })).toEqual({
      route: { name: 'notifications' },
    });
    expect(routeForPush({ type: 'contact', event: 'request' })).toEqual({ tab: 'contacts' });
  });

  it('ignores malformed or unknown data', () => {
    for (const data of [
      null,
      'message',
      {},
      { type: 'message' },
      { type: 'message', conversationId: '../../admin' },
      { type: 'unknown' },
    ]) {
      expect(routeForPush(data)).toBeUndefined();
    }
  });
});

describe('push registration', () => {
  const client = () => ({ registerPushToken: jest.fn((_token: string) => Promise.resolve()) });

  it('asks once after sign-in and registers nothing when refused', async () => {
    const api = client();
    expect(await registerForPush(api, 'OGC306841127', { prompt: true })).toEqual({
      status: 'permission-denied',
    });
    expect(mocked.requestPermissionsAsync).toHaveBeenCalled();
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

  it('does not prompt when not asked to', async () => {
    mocked.requestPermissionsAsync.mockClear();
    const api = client();
    expect(await registerForPush(api, 'OGC306841127', { prompt: false })).toEqual({
      status: 'permission-undetermined',
    });
    expect(mocked.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('registers the Expo token once, and again only when it changes', async () => {
    mocked.getPermissionsAsync.mockImplementation(() =>
      Promise.resolve({ status: 'granted', granted: true }),
    );
    const api = client();
    expect(await registerForPush(api, 'OGC306841127', { prompt: true })).toEqual({
      status: 'registered',
      token: 'ExponentPushToken[jest]',
    });
    expect(await registerForPush(api, 'OGC306841127', { prompt: true })).toEqual({
      status: 'unchanged',
    });
    expect(api.registerPushToken).toHaveBeenCalledTimes(1);
    mocked.getExpoPushTokenAsync.mockImplementationOnce(() =>
      Promise.resolve({ type: 'expo', data: 'ExponentPushToken[rotated]' }),
    );
    await registerForPush(api, 'OGC306841127', { prompt: false });
    expect(api.registerPushToken).toHaveBeenLastCalledWith('ExponentPushToken[rotated]');
  });

  it('reports a missing credential instead of crashing', async () => {
    mocked.getPermissionsAsync.mockImplementation(() =>
      Promise.resolve({ status: 'granted', granted: true }),
    );
    mocked.getExpoPushTokenAsync.mockImplementationOnce(() =>
      Promise.reject(new Error('Default FirebaseApp is not initialized')),
    );
    expect(await registerForPush(client(), 'OGC306841127', { prompt: false })).toMatchObject({
      status: 'error',
    });
  });

  it('never registers in Expo Go', async () => {
    const constants = Constants as { executionEnvironment: string };
    const previous = constants.executionEnvironment;
    constants.executionEnvironment = 'storeClient';
    const api = client();
    expect(await registerForPush(api, 'OGC306841127', { prompt: true })).toEqual({
      status: 'expo-go',
    });
    expect(api.registerPushToken).not.toHaveBeenCalled();
    constants.executionEnvironment = previous;
  });
});

// ── In the app ────────────────────────────────────────────────────────────────────────────

const account: AccountView = {
  ogcId: 'OGC306841127' as OgcId,
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  emailVerified: true,
  accountStatus: 'ACTIVE',
  createdAt: '2026-10-12T10:00:00.000Z',
};
const profile: OwnProfile = {
  ogcId: account.ogcId,
  displayName: 'Ada Lovelace',
  bio: null,
  avatarUrl: null,
  memberSince: account.createdAt,
  privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
};
const defaults: NotificationSettingsView = {
  enabled: true,
  messages: true,
  groups: true,
  channels: true,
  contactRequests: true,
  calls: true,
  preview: 'GENERIC',
  sound: true,
  vibration: true,
  quietHours: { enabled: false, start: 1320, end: 420, timeZone: 'UTC' },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const store: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function apiClient(options: { failSave?: boolean } = {}) {
  const puts: unknown[] = [];
  const routes: Record<string, (init: RequestInit) => Response> = {
    'POST /v1/auth/refresh': () =>
      json({
        account,
        session: {},
        tokens: { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_n' },
      }),
    'GET /v1/auth/me': () => json(account),
    'GET /v1/profile': () => json(profile),
    'GET /v1/notifications/settings': () => json(defaults),
    'PUT /v1/notifications/settings': (init) => {
      const body = JSON.parse(init.body as string) as Partial<NotificationSettingsView>;
      puts.push(body);
      return options.failSave ? json({ message: 'down' }, 503) : json({ ...defaults, ...body });
    },
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route(init)) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return { client: new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl }), puts };
}

async function openSettings(options: { failSave?: boolean } = {}) {
  const { client, puts } = apiClient(options);
  const messaging = fakeMessaging(new FakeEngine([CONVERSATION]));
  await render(<App client={client} messaging={messaging.dependencies} />);
  await fireEvent.press(await screen.findByRole('tab', { name: 'You' }));
  await fireEvent.press(await screen.findByText('Notification settings'));
  await screen.findByText('Direct messages');
  return puts;
}

describe('notification settings screen', () => {
  it('loads the saved settings and saves a change', async () => {
    const puts = await openSettings();
    expect(screen.getByText(/Nothing about who wrote is shared/)).toBeOnTheScreen();
    await fireEvent(screen.getByRole('switch', { name: 'Direct messages' }), 'valueChange', false);
    await waitFor(() => {
      expect(puts).toEqual([{ messages: false }]);
    });
  });

  it('explains the sender preview before anyone chooses it', async () => {
    const puts = await openSettings();
    await fireEvent.press(screen.getByRole('tab', { name: 'Show sender' }));
    await waitFor(() => {
      expect(puts).toEqual([{ preview: 'SENDER' }]);
    });
    expect(await screen.findByText(/Message text is never included/)).toBeOnTheScreen();
  });

  it('reverts and explains when saving fails', async () => {
    await openSettings({ failSave: true });
    const toggle = screen.getByRole('switch', { name: 'Calls' });
    await fireEvent(toggle, 'valueChange', false);
    expect(await screen.findByText(/could not be saved/)).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: 'Calls' }).props.value).toBe(true);
  });
});

describe('opening the app from a notification', () => {
  it('goes straight to the conversation the notification was about', async () => {
    mocked.getLastNotificationResponse.mockImplementation(() => ({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: {
        date: Date.now(),
        request: {
          identifier: 'push-1',
          content: {
            title: 'OGC',
            body: 'New message',
            data: { type: 'message', conversationId: CONVERSATION.id },
          },
          trigger: null,
        },
      },
    }));
    const { client } = apiClient();
    const messaging = fakeMessaging(new FakeEngine([CONVERSATION]));
    await render(<App client={client} messaging={messaging.dependencies} />);
    expect(await screen.findByLabelText('Message')).toBeOnTheScreen();
  });
});
