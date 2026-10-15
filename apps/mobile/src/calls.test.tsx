import { describe, expect, it, jest } from '@jest/globals';
import type { CallMediaPlatform, MediaRequest, MediaStreamLike } from '@ogc/messaging';
import type { AccountView, CallSetup, CallView, OgcId, OwnProfile } from '@ogc/types';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { FakeEngine, PEER, conversationView, fakeMessaging } from './test/fake-messaging';

/*
 * The mobile call interface with simulated media (fake microphone, camera and peer
 * connection). Real device-to-device calls need the development build on two phones; see
 * docs/development/calls.md.
 */

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(() => Promise.resolve()),
  deactivateKeepAwake: jest.fn(() => Promise.resolve()),
}));

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
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const store: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

const CONVERSATION = conversationView();

function client(history: CallView[] = []) {
  const routes: Record<string, () => Response> = {
    'POST /v1/auth/refresh': () =>
      json({
        account,
        session: {},
        tokens: { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_next' },
      }),
    'GET /v1/auth/me': () => json(account),
    'GET /v1/profile': () => json(ownProfile),
    [`GET /v1/calls?limit=50&conversationId=${CONVERSATION.id}`]: () =>
      json({ items: history, nextCursor: null }),
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  stop() {
    this.stopped = true;
  }
}

class FakePeer {
  iceConnectionState = 'new';
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  addTrack() {
    return undefined;
  }
  getSenders() {
    return [];
  }
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'offer' });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'answer' });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  addIceCandidate() {
    return Promise.resolve();
  }
  close() {
    return undefined;
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      listener as (event: unknown) => void,
    ]);
  }
  ice(state: string) {
    this.iceConnectionState = state;
    for (const listener of this.listeners.get('iceconnectionstatechange') ?? []) listener({});
  }
}

function fakeMedia(options: { deny?: boolean } = {}) {
  const requests: MediaRequest[] = [];
  const peers: FakePeer[] = [];
  const tracks: FakeTrack[] = [];
  const platform: CallMediaPlatform = {
    getUserMedia: (request) => {
      requests.push(request);
      if (options.deny) {
        const error = new Error('Permission denied.');
        error.name = 'SecurityError';
        return Promise.reject(error);
      }
      const list = [new FakeTrack('audio'), ...(request.video ? [new FakeTrack('video')] : [])];
      tracks.push(...list);
      const stream: MediaStreamLike = {
        getTracks: () => list,
        getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
        getVideoTracks: () => list.filter((t) => t.kind === 'video'),
      };
      return Promise.resolve(stream);
    },
    createPeerConnection: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer;
    },
  };
  return { platform, requests, peers, tracks };
}

function callView(patch: Partial<CallView> = {}): CallView {
  return {
    id: '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f',
    conversationId: CONVERSATION.id,
    media: 'AUDIO',
    direction: 'OUTGOING',
    peer: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
    status: 'RINGING',
    outcome: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    durationSeconds: null,
    ...patch,
  };
}

const setupFor = (call: CallView): { ok: true; data: CallSetup } => ({
  ok: true,
  data: { call, iceServers: [], iceTransportPolicy: 'all' },
});

async function openConversation(
  options: { media?: ReturnType<typeof fakeMedia>; noMedia?: boolean; history?: CallView[] } = {},
) {
  const media = options.media ?? fakeMedia();
  const messaging = fakeMessaging(
    new FakeEngine([CONVERSATION]),
    options.noMedia ? undefined : media.platform,
  );
  await render(<App client={client(options.history)} messaging={messaging.dependencies} />);
  await fireEvent.press(await screen.findByRole('tab', { name: /^Chats/ }));
  await fireEvent.press(await screen.findByRole('button', { name: /Grace Hopper/ }));
  await act(async () => {
    messaging.setConnection('online');
    await Promise.resolve();
  });
  return { messaging, media };
}

describe('mobile calls', () => {
  it('starts a voice call from a conversation without asking for the camera', async () => {
    const { messaging, media } = await openConversation();
    messaging.realtime.callReplies.set('call.start', () => setupFor(callView()));
    await fireEvent.press(await screen.findByRole('button', { name: 'Voice call Grace Hopper' }));

    expect(await screen.findByText('Calling…')).toBeTruthy();
    expect(media.requests).toEqual([{ audio: true, video: false }]);
    expect(messaging.realtime.callRequests[0]).toEqual({
      event: 'call.start',
      payload: { conversationId: CONVERSATION.id, media: 'AUDIO' },
    });
    // No camera control on a voice call.
    expect(screen.queryByRole('button', { name: 'Camera off' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Call cancelled')).toBeTruthy();
    expect(messaging.realtime.callRequests.at(-1)?.event).toBe('call.cancel');
    expect(media.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('shows who is calling and the call type, and declines', async () => {
    const { messaging } = await openConversation();
    await act(async () => {
      messaging.push('call.incoming', {
        call: callView({ direction: 'INCOMING', media: 'VIDEO' }),
      });
      await Promise.resolve();
    });
    expect(await screen.findByText('Incoming video call')).toBeTruthy();
    expect(screen.getByText('OGC 482 731 905')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => {
      expect(screen.queryByText('Incoming video call')).toBeNull();
    });
    expect(messaging.realtime.callRequests.at(-1)?.event).toBe('call.decline');
  });

  it('accepts a video call and starts the timer only when media connects', async () => {
    const { messaging, media } = await openConversation();
    const incoming = callView({ direction: 'INCOMING', media: 'VIDEO' });
    messaging.realtime.callReplies.set('call.accept', () =>
      setupFor({ ...incoming, status: 'ACCEPTED' }),
    );
    await act(async () => {
      messaging.push('call.incoming', { call: incoming });
      await Promise.resolve();
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Connecting…')).toBeTruthy();
    expect(media.requests).toEqual([{ audio: true, video: { facingMode: 'user' } }]);
    await waitFor(() => {
      expect(media.peers).toHaveLength(1);
    });
    expect(screen.queryByText('0:00')).toBeNull();

    await act(async () => {
      media.peers[0]?.ice('connected');
      await Promise.resolve();
    });
    expect(await screen.findByText('0:00')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Mute' }));
    const unmute = screen.getByRole('button', { name: 'Unmute' });
    expect(unmute.props.accessibilityState).toMatchObject({ selected: true });
    expect(media.tracks.find((t) => t.kind === 'audio')?.enabled).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Camera off' }));
    expect(media.tracks.find((t) => t.kind === 'video')?.enabled).toBe(false);

    await fireEvent.press(screen.getByRole('button', { name: 'End' }));
    expect(await screen.findByText('Call ended')).toBeTruthy();
    expect(messaging.realtime.callRequests.at(-1)?.event).toBe('call.end');
  });

  it('explains a refused microphone instead of calling', async () => {
    const { messaging } = await openConversation({ media: fakeMedia({ deny: true }) });
    await fireEvent.press(await screen.findByRole('button', { name: 'Voice call Grace Hopper' }));
    expect(
      await screen.findByText('OGC needs your microphone for calls. Allow access, then try again.'),
    ).toBeTruthy();
    expect(messaging.realtime.callRequests).toEqual([]);
  });

  it('says that Expo Go cannot take calls', async () => {
    const { messaging } = await openConversation({ noMedia: true });
    await act(async () => {
      messaging.push('call.incoming', { call: callView({ direction: 'INCOMING' }) });
      await Promise.resolve();
    });
    expect(await screen.findByText(/aren’t available in Expo Go/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('shows call history in the conversation', async () => {
    await openConversation({
      history: [
        callView({ direction: 'INCOMING', status: 'ENDED', outcome: 'MISSED', media: 'VIDEO' }),
      ],
    });
    const row = await screen.findByLabelText('Missed video call');
    expect(within(row).getByText('Missed video call')).toBeTruthy();
  });
});
