import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId, OwnProfile } from '@ogc/types';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
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

describe('mobile messaging', () => {
  it('shows unread messages on the Chats tab and lists conversations', async () => {
    const engine = new FakeEngine([conversationView({ unreadCount: 2 })]);
    const messaging = fakeMessaging(engine);
    await render(<App client={client()} messaging={messaging.dependencies} />);
    const entry = await screen.findByRole('tab', { name: 'Chats, 2 unread' });
    await fireEvent.press(entry);
    expect(await screen.findByRole('button', { name: 'Grace Hopper, 2 unread' })).toBeOnTheScreen();
  });

  it('renders messages safely with delivery state and placeholders', async () => {
    const engine = new FakeEngine([
      conversationView({ peerLastReadSeq: 2, peerLastDeliveredSeq: 2 }),
    ]);
    engine.data.set(CONVERSATION.id, [
      localMessage({ seq: 1, payload: { v: 1, text: '<script>alert(1)</script>' } }),
      localMessage({
        seq: 2,
        mine: true,
        senderOgcId: account.ogcId,
        payload: { v: 1, text: 'Seen?' },
      }),
      localMessage({ seq: 3, state: 'deleted', payload: null }),
      localMessage({ seq: 4, state: 'unavailable', payload: null }),
    ]);
    await openConversation(engine);
    expect(await screen.findByText('<script>alert(1)</script>')).toBeOnTheScreen();
    expect(screen.getByLabelText('Read')).toBeOnTheScreen();
    expect(screen.getByText('This message was deleted')).toBeOnTheScreen();
    expect(screen.getByText(/Sent before this device joined/)).toBeOnTheScreen();
  });

  it('sends, replies and signals typing', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    const theirs = localMessage({ seq: 1, payload: { v: 1, text: 'Lunch?' } });
    engine.data.set(CONVERSATION.id, [theirs]);
    const messaging = await openConversation(engine);

    await fireEvent.changeText(await screen.findByLabelText('Message'), 'On my way');
    expect(messaging.realtime.typingCalls).toContainEqual([CONVERSATION.id, true]);
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(engine.send).toHaveBeenCalledWith(CONVERSATION.id, { text: 'On my way' });

    await fireEvent(screen.getByText('Lunch?'), 'longPress');
    await fireEvent.press(await screen.findByRole('button', { name: 'Reply' }));
    expect(screen.getByText('Replying to')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Yes');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(engine.send).toHaveBeenLastCalledWith(CONVERSATION.id, {
      text: 'Yes',
      replyToId: theirs.id,
    });
  });

  it('edits, reacts and confirms before deleting for everyone', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    const mine = localMessage({
      seq: 1,
      mine: true,
      senderOgcId: account.ogcId,
      payload: { v: 1, text: 'Typo' },
    });
    engine.data.set(CONVERSATION.id, [mine]);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openConversation(engine);

    await fireEvent(await screen.findByText('Typo'), 'longPress');
    await fireEvent.press(await screen.findByRole('button', { name: 'React with heart' }));
    expect(engine.react).toHaveBeenCalledWith(CONVERSATION.id, mine.id, 'heart', true);

    await fireEvent(screen.getByText('Typo'), 'longPress');
    await fireEvent.press(await screen.findByRole('button', { name: 'Edit' }));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Fixed');
    await fireEvent.press(screen.getByRole('button', { name: 'Save edit' }));
    expect(engine.edit).toHaveBeenCalledWith(CONVERSATION.id, mine.id, 'Fixed');

    await fireEvent(await screen.findByText('Fixed'), 'longPress');
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete for everyone' }));
    expect(engine.deleteForEveryone).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Delete for everyone?',
      expect.stringContaining('can’t be recalled'),
      expect.any(Array),
    );
    const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => {
      buttons.find((b) => b.text === 'Delete')?.onPress?.();
      await Promise.resolve();
    });
    expect(engine.deleteForEveryone).toHaveBeenCalledWith(CONVERSATION.id, mine.id);
    alert.mockRestore();
  });

  it('shows typing and presence, and blocks the composer for a blocked person', async () => {
    const engine = new FakeEngine([conversationView({ blockedByMe: true })]);
    const unblock = jest.fn(() => json(null, 204));
    const messaging = await openConversation(engine, { [`DELETE /v1/blocks/${PEER}`]: unblock });
    expect(await screen.findByText(/You blocked Grace Hopper/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Message').props.editable).toBe(false);
    await act(async () => {
      messaging.push('message.typing', {
        conversationId: CONVERSATION.id,
        ogcId: PEER,
        typing: true,
      });
      await Promise.resolve();
    });
    expect(screen.getByText('typing…')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Unblock' }));
    expect(unblock).toHaveBeenCalled();
  });

  it('shows the safety number', async () => {
    await openConversation(new FakeEngine([CONVERSATION]));
    await fireEvent.press(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByLabelText(/Safety number 12345 67890/)).toBeOnTheScreen();
  });

  it('marks the person verified after comparing safety numbers', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    await openConversation(engine);
    await fireEvent.press(await screen.findByRole('button', { name: 'Verify' }));
    await screen.findByLabelText(/Safety number 12345 67890/);
    await fireEvent.press(screen.getByRole('button', { name: /mark as verified/ }));
    expect(engine.markPeerVerified).toHaveBeenCalledWith(CONVERSATION.id);
    // Back in the conversation, which now shows the verified state.
    expect(await screen.findByText(/· Verified/)).toBeOnTheScreen();
  });

  it('warns when the other person’s keys change, until dismissed', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    engine.peerKeys = { state: 'changed', added: 1 };
    await openConversation(engine);
    expect(await screen.findByText(/security keys changed/)).toBeOnTheScreen();
    expect(screen.queryByText(/· Verified/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(engine.acknowledgePeerKeys).toHaveBeenCalledWith(CONVERSATION.id);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/security keys changed/)).toBeNull();
  });

  it('starts a conversation from contacts', async () => {
    const engine = new FakeEngine([]);
    const messaging = fakeMessaging(engine);
    await render(
      <App
        client={client({
          'GET /v1/contacts': () =>
            json({
              items: [
                {
                  profile: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
                  since: account.createdAt,
                },
              ],
              nextCursor: null,
            }),
        })}
        messaging={messaging.dependencies}
      />,
    );
    await fireEvent.press(await screen.findByRole('tab', { name: /^Chats/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Start a conversation' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Message Grace Hopper' }));
    expect(engine.openDirect).toHaveBeenCalledWith(PEER);
    expect(await screen.findByLabelText('Message')).toBeOnTheScreen();
  });

  it('erases local messaging data on sign-out', async () => {
    const messaging = fakeMessaging(new FakeEngine([CONVERSATION]));
    await render(
      <App
        client={client({ 'POST /v1/auth/logout': () => json(null, 204) })}
        messaging={messaging.dependencies}
      />,
    );
    await fireEvent.press(await screen.findByRole('tab', { name: 'You' }));
    await fireEvent.press(await screen.findByText('Sign out'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(messaging.destroyed).toEqual([account.ogcId]);
  });
});
