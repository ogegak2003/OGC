import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId, OwnProfile } from '@ogc/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

const CONVERSATION = conversationView();

async function openConversation(engine: FakeEngine, extra: Record<string, () => Response> = {}) {
  const messaging = fakeMessaging(engine);
  await render(<App client={client(extra)} messaging={messaging.dependencies} />);
  await fireEvent.press(await screen.findByRole('tab', { name: /^Chats/ }));
  await fireEvent.press(await screen.findByRole('button', { name: /Grace Hopper/ }));
  return messaging;
}

const TEXT =
  'Encryption is waiting for another device to join this conversation. Your pending messages haven’t been sent yet.';

describe('mobile: encryption waiting for another device', () => {
  it('explains that pending messages have not been sent, in the affected conversation', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    engine.waitingForDevice.add(CONVERSATION.id);
    await openConversation(engine);
    expect(await screen.findByText(TEXT)).toBeOnTheScreen();
    expect(screen.getByLabelText('Encryption waiting')).toBeOnTheScreen();
    expect(engine.awaitingAnotherDevice).toHaveBeenCalledWith(CONVERSATION.id);
  });

  it('is not shown when this conversation is not waiting', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    engine.waitingForDevice.add('c0ffee00-0000-4000-8000-0000000000bb');
    await openConversation(engine);
    // The screen asked about this conversation (the other one is waiting, not this one).
    await waitFor(() => {
      expect(engine.awaitingAnotherDevice).toHaveBeenCalledWith(CONVERSATION.id);
    });
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(screen.queryByLabelText('Encryption waiting')).toBeNull();
  });

  it('clears when recovery resolves', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    engine.waitingForDevice.add(CONVERSATION.id);
    await openConversation(engine);
    expect(await screen.findByText(TEXT)).toBeOnTheScreen();
    await act(async () => {
      engine.waitingForDevice.delete(CONVERSATION.id);
      engine.emit({ type: 'recovery', conversationId: CONVERSATION.id });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText(TEXT)).toBeNull();
    });
  });
});
