import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, ChannelView, ConversationView, OgcId, OwnProfile } from '@ogc/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import {
  FakeEngine,
  PEER,
  conversationView,
  fakeMessaging,
  localMessage,
} from './test/fake-messaging';

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

const calls: { key: string; body: unknown }[] = [];

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
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({ key, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

const GROUP_ID = 'c0ffee00-0000-4000-8000-0000000000aa';
const CHANNEL_ID = 'c0ffee00-0000-4000-8000-0000000000cc';

function group(overrides: Partial<NonNullable<ConversationView['group']>> = {}): ConversationView {
  return conversationView({
    id: GROUP_ID,
    type: 'GROUP',
    peer: null,
    group: {
      kind: 'GROUP',
      name: 'Rowing club',
      description: null,
      avatarUrl: null,
      myRole: 'MEMBER',
      memberCount: 3,
      postPolicy: 'ALL_MEMBERS',
      invitePolicy: 'ADMINS',
      archived: false,
      canPost: true,
      ...overrides,
    },
  });
}

const members = () =>
  json([
    {
      profile: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
      role: 'OWNER',
      joinedAt: account.createdAt,
    },
    {
      profile: { ogcId: account.ogcId, displayName: 'Ada Lovelace', avatarUrl: null },
      role: 'MEMBER',
      joinedAt: account.createdAt,
    },
  ]);

describe('mobile groups and channels', () => {
  it('opens a group with its name, sender names and member count', async () => {
    const engine = new FakeEngine([group()]);
    engine.data.set(GROUP_ID, [
      localMessage({
        conversationId: GROUP_ID,
        senderOgcId: PEER,
        payload: { v: 1, text: 'Boat at 6' },
      }),
    ]);
    await render(
      <App
        client={client({ [`GET /v1/groups/${GROUP_ID}/members`]: members })}
        messaging={fakeMessaging(engine).dependencies}
      />,
    );
    await fireEvent.press(await screen.findByRole('button', { name: /^Messages/ }));
    await fireEvent.press(await screen.findByRole('button', { name: /Rowing club, group/ }));
    expect(await screen.findByText('Boat at 6')).toBeOnTheScreen();
    expect(await screen.findByText('Grace Hopper')).toBeOnTheScreen();
    expect(screen.getByText('3 members · End-to-end encrypted')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Info' })).toBeOnTheScreen();
  });

  it('explains when only admins can post and hides the composer', async () => {
    const engine = new FakeEngine([
      group({ kind: 'CHANNEL', postPolicy: 'ADMINS', canPost: false }),
    ]);
    await render(
      <App
        client={client({ [`GET /v1/groups/${GROUP_ID}/members`]: members })}
        messaging={fakeMessaging(engine).dependencies}
      />,
    );
    await fireEvent.press(await screen.findByRole('button', { name: /^Messages/ }));
    await fireEvent.press(await screen.findByRole('button', { name: /Rowing club, channel/ }));
    expect(await screen.findByText('Only admins can post here.')).toBeOnTheScreen();
  });

  it('shows community channels as not end-to-end encrypted', async () => {
    const channel: ChannelView = {
      id: CHANNEL_ID,
      handle: 'night_sky',
      name: 'Night Sky',
      description: null,
      avatarUrl: null,
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
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
    await render(
      <App
        client={client({
          'GET /v1/channels': () => json([channel]),
          [`GET /v1/channels/${CHANNEL_ID}`]: () => json(channel),
          [`GET /v1/channels/${CHANNEL_ID}/posts`]: () => json({ items: [], nextCursor: null }),
          [`GET /v1/channels/${CHANNEL_ID}/pinned`]: () => json([]),
          [`POST /v1/channels/${CHANNEL_ID}/join`]: () =>
            json({ target: 'COMMUNITY_CHANNEL', id: CHANNEL_ID, status: 'JOINED' }),
        })}
        messaging={fakeMessaging(new FakeEngine([])).dependencies}
      />,
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Community channels' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Night Sky' }));
    expect(await screen.findByText(/Not end-to-end encrypted/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => {
      expect(calls.some((c) => c.key === `POST /v1/channels/${CHANNEL_ID}/join`)).toBe(true);
    });
  });

  it('joins with a pasted invitation link, sending the token only in the body', async () => {
    const token = `ogc_inv_${'z'.repeat(43)}`;
    await render(
      <App
        client={client({
          'POST /v1/invite-links/preview': () =>
            json({
              target: 'GROUP',
              id: GROUP_ID,
              name: 'Rowing club',
              description: null,
              avatarUrl: null,
              memberCount: 3,
              alreadyMember: false,
              requiresApproval: false,
              endToEndEncrypted: true,
            }),
        })}
        messaging={fakeMessaging(new FakeEngine([])).dependencies}
      />,
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Join with a link' }));
    await fireEvent.changeText(
      screen.getByLabelText('Invitation link'),
      `https://ogc.example/join#token=${token}`,
    );
    expect(await screen.findByText('Rowing club')).toBeOnTheScreen();
    expect(calls.some((c) => c.key.includes(token))).toBe(false);
    expect(calls.find((c) => c.key === 'POST /v1/invite-links/preview')?.body).toEqual({ token });
  });
});
