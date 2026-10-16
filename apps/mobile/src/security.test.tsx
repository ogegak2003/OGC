import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, DeviceSessionView, OgcId, OwnProfile } from '@ogc/types';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { FakeEngine, fakeMessaging } from './test/fake-messaging';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

const account: AccountView = {
  ogcId: 'OGC306841127' as OgcId,
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  emailVerified: true,
  accountStatus: 'ACTIVE',
  createdAt: '2026-10-12T10:00:00.000Z',
};

const ownProfile: OwnProfile = {
  ogcId: account.ogcId,
  displayName: 'Ada Lovelace',
  bio: null,
  avatarUrl: null,
  memberSince: account.createdAt,
  privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
};

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const store: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

const HERE = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e01';
const LAPTOP = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e02';

function session(id: string, overrides: Partial<DeviceSessionView> = {}): DeviceSessionView {
  return {
    id,
    platform: 'WEB',
    deviceName: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: '2026-10-14T10:00:00.000Z',
    expiresAt: '2026-10-31T10:00:00.000Z',
    current: false,
    ...overrides,
  };
}

type Route = (init: RequestInit) => Response;

function apiClient(extra: Record<string, Route>) {
  const sent: { key: string; body: unknown }[] = [];
  const routes: Record<string, Route> = {
    'POST /v1/auth/refresh': () =>
      json({
        account,
        session: {},
        tokens: { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_next' },
      }),
    'GET /v1/auth/me': () => json(account),
    'GET /v1/profile': () => json(ownProfile),
    ...extra,
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init.method ?? 'GET'} ${url}`;
    if (init.method && init.method !== 'GET') {
      sent.push({ key, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    }
    const route = routes[key];
    return route ? Promise.resolve(route(init)) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return { client: new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl }), sent };
}

async function openSecurity(extra: Record<string, Route>) {
  const { client, sent } = apiClient(extra);
  const messaging = fakeMessaging(new FakeEngine([]));
  await render(<App client={client} messaging={messaging.dependencies} />);
  await fireEvent.press(await screen.findByRole('tab', { name: 'You' }));
  await fireEvent.press(await screen.findByText('Security and devices'));
  return sent;
}

describe('mobile security and devices', () => {
  it('lists other devices and signs out a lost one', async () => {
    let sessions = [
      session(HERE, { current: true, platform: 'ANDROID' }),
      session(LAPTOP, { deviceName: 'Work laptop' }),
    ];
    const sent = await openSecurity({
      'GET /v1/auth/sessions': () => json(sessions),
      [`DELETE /v1/auth/sessions/${LAPTOP}`]: () => {
        sessions = sessions.filter((s) => s.id !== LAPTOP);
        return json(null, 204);
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out Work laptop' }));
    // Signing a device out is confirmed first.
    expect(sent.map((s) => s.key)).not.toContain(`DELETE /v1/auth/sessions/${LAPTOP}`);
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm sign out Work laptop' }));
    expect(await screen.findByText('Work laptop was signed out.')).toBeOnTheScreen();
    expect(sent.map((s) => s.key)).toContain(`DELETE /v1/auth/sessions/${LAPTOP}`);
    expect(await screen.findByText('You are not signed in anywhere else.')).toBeOnTheScreen();
  });

  it('changes the password, validating it first', async () => {
    const sent = await openSecurity({
      'GET /v1/auth/sessions': () => json([session(HERE, { current: true })]),
      'POST /v1/auth/password': () => json({ otherSessionsEnded: 2 }),
    });
    await fireEvent.changeText(
      await screen.findByLabelText('Current password'),
      'correct horse battery staple',
    );
    await fireEvent.changeText(screen.getByLabelText('New password'), 'short');
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    expect(sent.filter((s) => s.key === 'POST /v1/auth/password')).toHaveLength(0);

    await fireEvent.changeText(
      screen.getByLabelText('New password'),
      'violet harbour telescope morning',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Password changed. 2 other devices were signed out.'),
    ).toBeOnTheScreen();
    expect(sent.find((s) => s.key === 'POST /v1/auth/password')?.body).toEqual({
      currentPassword: 'correct horse battery staple',
      newPassword: 'violet harbour telescope morning',
    });
  });

  it('reports a wrong current password', async () => {
    await openSecurity({
      'GET /v1/auth/sessions': () => json([session(HERE, { current: true })]),
      'POST /v1/auth/password': () =>
        json(
          {
            statusCode: 400,
            error: 'BAD_REQUEST',
            message: 'Current password is not correct',
            code: 'INVALID_PASSWORD',
          },
          400,
        ),
    });
    await fireEvent.changeText(await screen.findByLabelText('Current password'), 'wrong guess');
    await fireEvent.changeText(
      screen.getByLabelText('New password'),
      'violet harbour telescope morning',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Your current password is not correct.')).toBeOnTheScreen();
  });
});
