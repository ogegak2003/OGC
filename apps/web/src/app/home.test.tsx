import type { CallView, OgcId } from '@ogc/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, PEER, conversationView, fakeMessaging } from '../test/fake-messaging';
import { json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GRACE = conversationView();
const ALAN = conversationView({
  id: 'c0ffee00-0000-4000-8000-000000000002',
  peer: { ogcId: 'OGC111222333' as OgcId, displayName: 'Alan Turing', avatarUrl: null },
});

function missedCall(): CallView {
  return {
    id: '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f',
    conversationId: GRACE.id,
    media: 'VIDEO',
    direction: 'INCOMING',
    peer: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
    status: 'ENDED',
    outcome: 'MISSED',
    createdAt: new Date().toISOString(),
    answeredAt: null,
    connectedAt: null,
    endedAt: new Date().toISOString(),
    durationSeconds: null,
  };
}

function open(path: string, calls: CallView[] = []) {
  const messaging = fakeMessaging(new FakeEngine([GRACE, ALAN]));
  // Only Grace is online: the dashboard must not show Alan as online.
  messaging.realtime.subscribePresence = vi.fn((ogcIds: OgcId[]) =>
    Promise.resolve(
      ogcIds.map((ogcId) => ({
        ogcId,
        state: ogcId === PEER ? ('ONLINE' as const) : ('OFFLINE' as const),
      })),
    ),
  );
  mockApi({
    ...signedInRoutes(),
    'GET /api/v1/calls?limit=50': () => json({ items: calls, nextCursor: null }),
  });
  renderApp(path, messaging.dependencies);
  return messaging;
}

describe('web dashboard', () => {
  it('welcomes the signed-in person by their real name', async () => {
    open('/home');
    const hero = await screen.findByRole('region', { name: /Ada Lovelace/ });
    expect(within(hero).getByRole('button', { name: /Start a conversation/ })).toBeTruthy();
    // The identity panel keeps the OGC ID, QR and sharing.
    expect(screen.getByRole('heading', { name: 'Your OGC ID' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'QR code for OGC306841127' })).toBeTruthy();
  });

  it('lists only people who are actually online, with call buttons', async () => {
    open('/home');
    const online = await screen.findByRole('region', { name: 'Online now' });
    expect(await within(online).findByText('Grace Hopper')).toBeTruthy();
    expect(within(online).queryByText('Alan Turing')).toBeNull();
    expect(within(online).getByRole('button', { name: 'Voice call Grace Hopper' })).toBeTruthy();
  });

  it('shows real conversations and calls in the activity feed', async () => {
    open('/home', [missedCall()]);
    const feed = await screen.findByRole('list', { name: 'Recent conversations and calls' });
    expect(await within(feed).findByText('Missed video call')).toBeTruthy();
    expect(within(feed).getAllByText('Grace Hopper').length).toBeGreaterThan(0);
    expect(within(feed).getByText('Alan Turing')).toBeTruthy();
  });

  it('opens the calls page from the Start call quick action', async () => {
    open('/home', [missedCall()]);
    fireEvent.click(await screen.findByRole('link', { name: /Start call/ }));
    expect(await screen.findByRole('heading', { name: 'Recent calls' })).toBeTruthy();
    expect(await screen.findByText('Missed video call')).toBeTruthy();
    const start = screen.getByRole('region', { name: 'Start a call' });
    expect(within(start).getByText('Alan Turing')).toBeTruthy();
  });

  it('searches the person’s own conversations and opens one', async () => {
    open('/home');
    await screen.findByRole('region', { name: /Ada Lovelace/ });
    const [search] = screen.getAllByRole('combobox', { name: 'Search chats, people or channels' });
    if (!search) throw new Error('search missing');
    fireEvent.change(search, { target: { value: 'alan' } });
    const option = await screen.findByRole('option', { name: /Alan Turing/ });
    expect(screen.getByRole('option', { name: /Find “alan” by OGC ID/ })).toBeTruthy();
    fireEvent.pointerDown(option);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Conversation with Alan Turing' })).toBeTruthy();
    });
  });

  it('sends OGC ID searches to Discover, prefilled', async () => {
    open('/home');
    await screen.findByRole('region', { name: /Ada Lovelace/ });
    const [search] = screen.getAllByRole('combobox', { name: 'Search chats, people or channels' });
    if (!search) throw new Error('search missing');
    fireEvent.change(search, { target: { value: 'OGC 482 731 905' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect((await screen.findByLabelText<HTMLInputElement>('OGC ID')).value).toBe(
      'OGC 482 731 905',
    );
  });
});
