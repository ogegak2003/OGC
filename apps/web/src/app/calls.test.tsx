import type { CallMediaPlatform, MediaRequest, MediaStreamLike } from '@ogc/messaging';
import type { CallSetup, CallView } from '@ogc/types';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, PEER, conversationView, fakeMessaging } from '../test/fake-messaging';
import { json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

/*
 * The web call interface with simulated media (fake camera, microphone and peer
 * connection). Real browser-to-browser media is covered by the manual two-device test in
 * docs/development/calls.md, not here.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
      listener as (e: unknown) => void,
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
        const error = new Error('Permission denied');
        error.name = 'NotAllowedError';
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

const CONVERSATION = conversationView();
const OPEN = `/messages/${CONVERSATION.id}`;
const HISTORY = `GET /api/v1/calls?limit=50&conversationId=${CONVERSATION.id}`;

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

async function open(
  options: {
    media?: ReturnType<typeof fakeMedia>;
    /** A browser without WebRTC (or not on HTTPS). */
    noMedia?: boolean;
    history?: CallView[];
    conversation?: typeof CONVERSATION;
  } = {},
) {
  const media = options.media ?? fakeMedia();
  const messaging = fakeMessaging(
    new FakeEngine([options.conversation ?? CONVERSATION]),
    options.noMedia ? undefined : media.platform,
  );
  mockApi({
    ...signedInRoutes(),
    [HISTORY]: () => json({ items: options.history ?? [], nextCursor: null }),
  });
  renderApp(OPEN, messaging.dependencies);
  await screen.findByRole('region', { name: 'Conversation with Grace Hopper' });
  act(() => {
    messaging.setConnection('online');
  });
  return { messaging, media };
}

describe('calls on the web', () => {
  it('starts a voice call from a direct conversation without asking for the camera', async () => {
    const { messaging, media } = await open();
    messaging.realtime.callReplies.set('call.start', () => setupFor(callView()));
    const voice = await screen.findByRole('button', { name: 'Voice call Grace Hopper' });
    await waitFor(() => {
      expect(voice).toHaveProperty('disabled', false);
    });
    fireEvent.click(voice);

    const dialog = await screen.findByRole('dialog', { name: 'Grace Hopper' });
    expect(await within(dialog).findByText('Calling…')).toBeTruthy();
    expect(media.requests).toEqual([{ audio: true, video: false }]);
    expect(messaging.realtime.callRequests[0]).toEqual({
      event: 'call.start',
      payload: { conversationId: CONVERSATION.id, media: 'AUDIO' },
    });
    // No camera control on a voice call.
    expect(within(dialog).queryByRole('button', { name: 'Turn camera off' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel call' }));
    expect(await within(dialog).findByText('Call cancelled')).toBeTruthy();
    expect(messaging.realtime.callRequests.at(-1)?.event).toBe('call.cancel');
    expect(media.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('shows an incoming call with the caller and call type, and declines it', async () => {
    const { messaging } = await open();
    act(() => {
      messaging.push('call.incoming', {
        call: callView({ direction: 'INCOMING', media: 'VIDEO' }),
      });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Grace Hopper' });
    expect(within(dialog).getByText('Incoming video call')).toBeTruthy();
    expect(within(dialog).getByText('OGC 482 731 905')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Grace Hopper' })).toBeNull();
    });
    expect(messaging.realtime.callRequests.at(-1)?.event).toBe('call.decline');
  });

  it('accepts a video call, connects for real, and offers mute and camera controls', async () => {
    const { messaging, media } = await open();
    const incoming = callView({ direction: 'INCOMING', media: 'VIDEO' });
    messaging.realtime.callReplies.set('call.accept', () =>
      setupFor({ ...incoming, status: 'ACCEPTED' }),
    );
    act(() => {
      messaging.push('call.incoming', { call: incoming });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Grace Hopper' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    expect(await within(dialog).findByText('Connecting…')).toBeTruthy();
    expect(media.requests).toEqual([{ audio: true, video: { facingMode: 'user' } }]);
    // No timer until media actually connects.
    expect(within(dialog).queryByText('0:00')).toBeNull();

    // The peer connection exists once the server confirmed the answer.
    await waitFor(() => {
      expect(media.peers).toHaveLength(1);
    });
    act(() => {
      media.peers[0]?.ice('connected');
    });
    expect(await within(dialog).findByText('0:00')).toBeTruthy();
    expect(messaging.realtime.callRequests.map((r) => r.event)).toContain('call.connected');

    const mute = within(dialog).getByRole('button', { name: 'Mute' });
    fireEvent.click(mute);
    expect(
      within(dialog).getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(media.tracks.find((t) => t.kind === 'audio')?.enabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn camera off' }));
    expect(media.tracks.find((t) => t.kind === 'video')?.enabled).toBe(false);

    act(() => {
      messaging.push('call.ended', {
        call: { ...incoming, status: 'ENDED', outcome: 'COMPLETED', durationSeconds: 4 },
        reason: 'hangup',
      });
    });
    expect(await within(dialog).findByText('Call ended')).toBeTruthy();
    expect(media.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('explains a refused microphone instead of calling', async () => {
    const { messaging } = await open({ media: fakeMedia({ deny: true }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Voice call Grace Hopper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grace Hopper' });
    expect(
      await within(dialog).findByText(
        'OGC needs your microphone for calls. Allow access, then try again.',
      ),
    ).toBeTruthy();
    expect(messaging.realtime.callRequests).toEqual([]);
  });

  it('says when this browser cannot make calls', async () => {
    const { messaging } = await open({ noMedia: true });
    const voice = await screen.findByRole('button', { name: 'Voice call Grace Hopper' });
    expect(voice).toHaveProperty('disabled', true);
    expect(voice.getAttribute('title')).toMatch(/HTTPS/);
    act(() => {
      messaging.push('call.incoming', { call: callView({ direction: 'INCOMING' }) });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Grace Hopper' });
    expect(within(dialog).getByText(/not available on this device/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Accept' })).toHaveProperty('disabled', true);
  });

  it('shows call history in the conversation', async () => {
    await open({
      history: [
        callView({
          id: '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e40',
          direction: 'INCOMING',
          status: 'ENDED',
          outcome: 'MISSED',
          media: 'VIDEO',
        }),
        callView({ status: 'ENDED', outcome: 'COMPLETED', durationSeconds: 151 }),
      ],
    });
    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(await within(log).findByText('Missed video call')).toBeTruthy();
    expect(within(log).getByText('Outgoing voice call · 2:31')).toBeTruthy();
  });

  it('offers no calls to someone you blocked', async () => {
    await open({ conversation: conversationView({ blockedByMe: true }) });
    expect(screen.queryByRole('button', { name: 'Voice call Grace Hopper' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Video call Grace Hopper' })).toBeNull();
  });
});
