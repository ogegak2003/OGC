import { describe, expect, it, jest } from '@jest/globals';
import type { GroupSecurityEvent } from '@ogc/messaging';
import type { AccountView, ConversationView, OgcId, OwnProfile } from '@ogc/types';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { FakeEngine, PEER, conversationView, fakeMessaging } from './test/fake-messaging';

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
    const route = routes[key];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

const GROUP_ID = 'c0ffee00-0000-4000-8000-0000000000ab';

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

function securityEvent(overrides: Partial<GroupSecurityEvent> = {}): GroupSecurityEvent {
  return {
    id: `3:new-device:${PEER}`,
    epoch: 3,
    change: 'new-device',
    level: 'verify',
    ogcId: PEER,
    devices: 1,
    via: 'member',
    by: PEER,
    acknowledged: false,
    ...overrides,
  };
}

async function openGroup(events: GroupSecurityEvent[]) {
  const engine = new FakeEngine([group()]);
  engine.security.set(GROUP_ID, events);
  await render(
    <App
      client={client({ [`GET /v1/groups/${GROUP_ID}/members`]: members })}
      messaging={fakeMessaging(engine).dependencies}
    />,
  );
  await fireEvent.press(await screen.findByRole('tab', { name: /^Chats/ }));
  await fireEvent.press(await screen.findByRole('button', { name: /Rowing club, group/ }));
  return engine;
}

describe('mobile group security warnings', () => {
  it('asks to verify a member’s new key and dismisses the warning', async () => {
    const engine = await openGroup([securityEvent()]);
    expect(
      await screen.findByText(/Grace Hopper has a new security key in this group/),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/attack|compromised/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Compare' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(engine.acknowledgeGroupSecurity).toHaveBeenCalledWith(GROUP_ID);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/has a new security key/)).toBeNull();
  });

  it('uses cautious wording for changes this device could not check', async () => {
    await openGroup([
      securityEvent({
        id: '9:resynced:',
        change: 'resynced',
        level: 'unconfirmed',
        ogcId: null,
        via: 'rejoin',
        by: null,
      }),
    ]);
    expect(await screen.findByText(/couldn’t be checked on this device/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull();
  });

  it('shows nothing for ordinary, confirmed membership changes', async () => {
    await openGroup([
      securityEvent({ change: 'member-joined', level: 'confirmed', acknowledged: true }),
    ]);
    expect(await screen.findByText('3 members · End-to-end encrypted')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Group security')).toBeNull();
  });
});
