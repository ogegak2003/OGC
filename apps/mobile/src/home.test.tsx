import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId, OwnProfile } from '@ogc/types';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { FakeEngine, conversationView, fakeMessaging } from './test/fake-messaging';

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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

const store: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function client() {
  const routes: Record<string, () => Response> = {
    'POST /v1/auth/refresh': () =>
      json({
        account,
        session: {},
        tokens: { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_next' },
      }),
    'GET /v1/auth/me': () => json(account),
    'GET /v1/profile': () => json(ownProfile),
    'GET /v1/calls?limit=50': () => json({ items: [], nextCursor: null }),
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

async function openHome(unreadCount = 0) {
  const messaging = fakeMessaging(new FakeEngine([conversationView({ unreadCount })]));
  await render(<App client={client()} messaging={messaging.dependencies} />);
  await screen.findByText('Ada Lovelace');
  return messaging;
}

describe('mobile home', () => {
  it('greets the signed-in person by name and shows their OGC ID', async () => {
    await openHome();
    expect(screen.getByText('Your Global Identity')).toBeOnTheScreen();
    expect(screen.getByText('OGC 306 841 127')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Show my QR code' })).toBeOnTheScreen();
    // Real conversations, not sample data.
    expect(await screen.findByText('Grace Hopper')).toBeOnTheScreen();
  });

  it('shows the real unread count on the Messages shortcut', async () => {
    await openHome(3);
    expect(await screen.findByRole('button', { name: 'Messages, 3 unread' })).toBeOnTheScreen();
  });

  it('opens the Calls screen from its shortcut', async () => {
    await openHome();
    await fireEvent.press(screen.getByRole('button', { name: 'Calls, Voice & video' }));
    expect(await screen.findByText('Recent calls')).toBeOnTheScreen();
    expect(await screen.findByText('No calls yet')).toBeOnTheScreen();
  });

  it('creates from the central button: new group', async () => {
    await openHome();
    await fireEvent.press(screen.getByRole('button', { name: 'Create' }));
    const sheet = await screen.findByText('Create');
    expect(sheet).toBeOnTheScreen();
    for (const label of [
      'New chat',
      'New group',
      'New channel',
      'Start a call',
      'Find by OGC ID',
    ]) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
    }
    const [newGroup] = screen.getAllByRole('button', { name: 'New group' });
    if (!newGroup) throw new Error('missing');
    await fireEvent.press(newGroup);
    expect(await screen.findByLabelText('Name')).toBeOnTheScreen();
  });

  it('keeps every tab in the bottom navigation', async () => {
    await openHome();
    for (const name of ['Home', 'Chats', 'Contacts', 'Communities', 'You']) {
      expect(screen.getByRole('tab', { name })).toBeOnTheScreen();
    }
  });
});
