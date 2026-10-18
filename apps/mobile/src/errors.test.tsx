import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AccountView, ChannelView, OgcId, OwnProfile } from '@ogc/types';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
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
const failure = (status: 403 | 404) => () =>
  json(
    { statusCode: status, error: status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', message: 'x' },
    status,
  );
const store: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function client(extra: Record<string, () => Response> = {}) {
  const routes: Record<string, () => Response> = {
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
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

const CHANNEL_ID = 'c0ffee00-0000-4000-8000-0000000000cc';
const channel: ChannelView = {
  id: CHANNEL_ID,
  handle: 'night_sky',
  name: 'Night Sky',
  description: null,
  avatarUrl: null,
  visibility: 'PRIVATE',
  joinPolicy: 'APPROVAL',
  postPolicy: 'ADMINS',
  repliesEnabled: true,
  memberCount: 4,
  version: 2,
  archived: false,
  lastPostAt: null,
  createdAt: account.createdAt,
  endToEndEncrypted: false,
  membership: null,
  unreadCount: 0,
  canPost: false,
  canReply: false,
  canModerate: false,
};

/** Opens Communities and the listed channel, whose details then answer `status`. */
async function openChannelAnswering(status: 403 | 404) {
  await render(
    <App
      client={client({
        'GET /v1/channels': () => json([channel]),
        [`GET /v1/channels/${CHANNEL_ID}`]: failure(status),
        [`GET /v1/channels/${CHANNEL_ID}/posts`]: failure(status),
        [`GET /v1/channels/${CHANNEL_ID}/pinned`]: failure(status),
      })}
      messaging={fakeMessaging(new FakeEngine([])).dependencies}
    />,
  );
  await fireEvent.press(await screen.findByRole('tab', { name: 'Communities' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Night Sky' }));
}

describe('mobile not-found and access-denied states', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  });

  it('explains a channel that is not available, with Home and Back', async () => {
    await openChannelAnswering(404);
    expect(await screen.findByRole('header', { name: 'Channel not available' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Go to Home' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeOnTheScreen();
    // Back returns to the list it came from.
    await fireEvent.press(screen.getByRole('button', { name: 'Go back' }));
    expect(await screen.findByRole('button', { name: 'Night Sky' })).toBeOnTheScreen();
  });

  it('shows "no access" for a forbidden channel, and Home leaves it', async () => {
    await openChannelAnswering(403);
    expect(
      await screen.findByRole('header', { name: 'You don’t have access to this channel' }),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Go to Home' }));
    expect(await screen.findByText('Ada Lovelace')).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: /access to this channel/ })).toBeNull();
  });

  it('explains an OGC profile link that is not available without revealing more', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('ogc://id/OGC482731905');
    await render(
      <App
        client={client({ 'GET /v1/profiles/OGC482731905': failure(404) })}
        messaging={fakeMessaging(new FakeEngine([])).dependencies}
      />,
    );
    expect(await screen.findByRole('header', { name: 'Profile not available' })).toBeOnTheScreen();
    expect(screen.getByText(/may not be visible to you/)).toBeOnTheScreen();
  });
});
