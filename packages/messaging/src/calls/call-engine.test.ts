import type { CallSetup, CallView, ProfileSummary } from '@ogc/types';
import { describe, expect, it } from 'vitest';
import {
  type CallAck,
  CallEngine,
  type CallRequestName,
  type CallSignaling,
  type Clock,
  MEDIA_RECOVERY_TIMEOUT_MS,
} from './call-engine.js';
import { callDescription, callDuration } from './call-display.js';
import type {
  CallMediaPlatform,
  IceCandidateLike,
  MediaRequest,
  MediaStreamLike,
  PeerConnectionLike,
  SessionDescriptionLike,
} from './media.js';

/*
 * Simulated media: these tests drive the engine with fake peer connections, devices and
 * signaling. They verify the call logic, not real network or media behaviour (which needs
 * two real devices; see docs/development/calls.md).
 */

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream implements MediaStreamLike {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

class FakePeer implements PeerConnectionLike {
  iceConnectionState = 'new';
  closed = false;
  readonly tracks: FakeTrack[] = [];
  readonly offers: { iceRestart?: boolean }[] = [];
  readonly local: SessionDescriptionLike[] = [];
  readonly remote: SessionDescriptionLike[] = [];
  readonly candidates: IceCandidateLike[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly config: unknown) {}
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  getSenders() {
    return [];
  }
  createOffer(options?: { iceRestart?: boolean }) {
    this.offers.push(options ?? {});
    return Promise.resolve({ type: 'offer', sdp: `offer-${String(this.offers.length)}` });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' });
  }
  setLocalDescription(d: SessionDescriptionLike) {
    this.local.push(d);
    return Promise.resolve();
  }
  setRemoteDescription(d: SessionDescriptionLike) {
    this.remote.push(d);
    return Promise.resolve();
  }
  addIceCandidate(c: IceCandidateLike) {
    this.candidates.push(c);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      listener as (e: unknown) => void,
    ]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  ice(state: string) {
    this.iceConnectionState = state;
    this.emit('iceconnectionstatechange');
  }
}

class FakePlatform implements CallMediaPlatform {
  readonly requests: MediaRequest[] = [];
  readonly peers: FakePeer[] = [];
  readonly streams: FakeStream[] = [];
  failWith: string | undefined;
  getUserMedia(request: MediaRequest) {
    this.requests.push(request);
    if (this.failWith) {
      const error = new Error('denied');
      error.name = this.failWith;
      return Promise.reject(error);
    }
    const stream = new FakeStream([
      new FakeTrack('audio'),
      ...(request.video ? [new FakeTrack('video')] : []),
    ]);
    this.streams.push(stream);
    return Promise.resolve(stream);
  }
  /** The first peer connection created (throws if none was). */
  peer(): FakePeer {
    const peer = this.peers[0];
    if (!peer) throw new Error('no peer connection');
    return peer;
  }
  createPeerConnection(config: unknown) {
    const peer = new FakePeer(config);
    this.peers.push(peer);
    return peer;
  }
}

interface Sent {
  event: CallRequestName;
  payload: unknown;
}

class FakeSignaling implements CallSignaling {
  readonly sent: Sent[] = [];
  readonly replies = new Map<CallRequestName, (payload: never) => unknown>();
  callRequest<E extends CallRequestName>(event: E, payload: never): Promise<CallAck<E>> {
    this.sent.push({ event, payload });
    const reply = this.replies.get(event);
    return Promise.resolve((reply ? reply(payload) : { ok: true, data: null }) as CallAck<E>);
  }
  of(event: CallRequestName) {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload);
  }
}

class ManualClock implements Clock {
  time = 1_000_000;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private next = 0;
  now() {
    return this.time;
  }
  setTimeout(run: () => void, ms: number) {
    const id = ++this.next;
    this.timers.push({ at: this.time + ms, run, id });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  advance(ms: number) {
    this.time += ms;
    const due = this.timers.filter((t) => t.at <= this.time);
    this.timers = this.timers.filter((t) => t.at > this.time);
    for (const timer of due) timer.run();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const bob: ProfileSummary = {
  ogcId: 'OGC000000002' as ProfileSummary['ogcId'],
  displayName: 'Bob',
  avatarUrl: null,
};
const alice: ProfileSummary = {
  ogcId: 'OGC000000001' as ProfileSummary['ogcId'],
  displayName: 'Alice',
  avatarUrl: null,
};

function view(patch: Partial<CallView> = {}): CallView {
  return {
    id: 'call-1',
    conversationId: 'conv-1',
    media: 'AUDIO',
    direction: 'OUTGOING',
    peer: bob,
    status: 'RINGING',
    outcome: null,
    createdAt: '2026-10-15T10:00:00.000Z',
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    durationSeconds: null,
    ...patch,
  };
}

const setup = (call: CallView): { ok: true; data: CallSetup } => ({
  ok: true,
  data: {
    call,
    iceServers: [{ urls: ['stun:stun.example.org'] }],
    iceTransportPolicy: 'all',
  },
});

function harness() {
  const platform = new FakePlatform();
  const signaling = new FakeSignaling();
  const clock = new ManualClock();
  const engine = new CallEngine(signaling, platform, clock);
  return { platform, signaling, clock, engine };
}

async function outgoingConnected(media: 'AUDIO' | 'VIDEO' = 'AUDIO') {
  const h = harness();
  h.signaling.replies.set('call.start', () => setup(view({ media })));
  await h.engine.start('conv-1', media, bob);
  h.engine.handleEvent('call.accepted', { callId: 'call-1' });
  await flush();
  const peer = h.platform.peer();
  h.engine.handleEvent('call.signal', { callId: 'call-1', signal: { type: 'answer', sdp: 'a' } });
  await flush();
  peer.ice('connected');
  return { ...h, peer };
}

describe('CallEngine — outgoing calls', () => {
  it('never asks for the camera on a voice call, and rings only after the microphone is open', async () => {
    const { platform, signaling, engine } = harness();
    signaling.replies.set('call.start', () => setup(view()));
    await engine.start('conv-1', 'AUDIO', bob);
    expect(platform.requests).toEqual([{ audio: true, video: false }]);
    expect(signaling.of('call.start')).toEqual([{ conversationId: 'conv-1', media: 'AUDIO' }]);
    expect(engine.current).toMatchObject({ phase: 'outgoing', direction: 'OUTGOING' });
    expect(engine.current.peer?.displayName).toBe('Bob');
    expect(engine.current.connectedAt).toBeNull();
  });

  it('asks for the front camera on a video call', async () => {
    const { platform, signaling, engine } = harness();
    signaling.replies.set('call.start', () => setup(view({ media: 'VIDEO' })));
    await engine.start('conv-1', 'VIDEO', bob);
    expect(platform.requests).toEqual([{ audio: true, video: { facingMode: 'user' } }]);
    expect(engine.current.localStream?.getVideoTracks()).toHaveLength(1);
  });

  it('does not ring anyone when microphone access is denied', async () => {
    const { platform, signaling, engine } = harness();
    platform.failWith = 'NotAllowedError';
    await engine.start('conv-1', 'AUDIO', bob);
    expect(signaling.sent).toEqual([]);
    expect(engine.current).toMatchObject({
      phase: 'ended',
      ending: { reason: 'permission_denied' },
    });
  });

  it('reports a missing device', async () => {
    const { platform, engine } = harness();
    platform.failWith = 'NotFoundError';
    await engine.start('conv-1', 'VIDEO', bob);
    expect(engine.current.ending?.reason).toBe('no_device');
  });

  it('shows busy and releases the microphone', async () => {
    const { platform, signaling, engine } = harness();
    signaling.replies.set('call.start', () =>
      setup(view({ status: 'ENDED', outcome: 'BUSY', endedAt: '2026-10-15T10:00:00.000Z' })),
    );
    await engine.start('conv-1', 'AUDIO', bob);
    expect(engine.current).toMatchObject({
      phase: 'ended',
      ending: { outcome: 'BUSY', reason: 'busy' },
    });
    expect(platform.streams[0]?.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('maps server refusals to failures', async () => {
    const { signaling, engine } = harness();
    signaling.replies.set('call.start', () => ({ ok: false, error: 'in_call' }));
    await engine.start('conv-1', 'AUDIO', bob);
    expect(engine.current.ending?.reason).toBe('in_call');
  });

  it('offers after the answer arrives, then connects and starts the clock on real connection only', async () => {
    const { platform, signaling, clock, engine } = harness();
    signaling.replies.set('call.start', () => setup(view()));
    await engine.start('conv-1', 'AUDIO', bob);
    expect(platform.peers).toHaveLength(0);

    engine.handleEvent('call.accepted', { callId: 'call-1' });
    await flush();
    const peer = platform.peer();
    expect(peer.config).toEqual({
      iceServers: [{ urls: ['stun:stun.example.org'] }],
      iceTransportPolicy: 'all',
    });
    expect(peer.tracks.map((t) => t.kind)).toEqual(['audio']);
    expect(signaling.of('call.signal')).toEqual([
      { callId: 'call-1', signal: { type: 'offer', sdp: 'offer-1' } },
    ]);
    expect(engine.current.phase).toBe('connecting');

    peer.emit('icecandidate', {
      candidate: { candidate: 'cand-1', sdpMid: '0', sdpMLineIndex: 0 },
    });
    peer.emit('icecandidate', { candidate: null });
    expect(signaling.of('call.signal')).toContainEqual({
      callId: 'call-1',
      signal: { type: 'ice', candidate: 'cand-1', sdpMid: '0', sdpMLineIndex: 0 },
    });

    engine.handleEvent('call.signal', {
      callId: 'call-1',
      signal: { type: 'answer', sdp: 'answer' },
    });
    await flush();
    expect(peer.remote).toEqual([{ type: 'answer', sdp: 'answer' }]);
    expect(engine.current.connectedAt).toBeNull();

    clock.advance(1500);
    peer.ice('connected');
    expect(engine.current).toMatchObject({ phase: 'active', connectedAt: clock.now() });
    expect(signaling.of('call.connected')).toEqual([{ callId: 'call-1' }]);
  });
});

describe('CallEngine — incoming calls', () => {
  function ringing(media: 'AUDIO' | 'VIDEO' = 'VIDEO') {
    const h = harness();
    h.engine.handleEvent('call.incoming', {
      call: view({ media, direction: 'INCOMING', peer: alice }),
    });
    return h;
  }

  it('shows who is calling and the call type', () => {
    const { engine } = ringing();
    expect(engine.current).toMatchObject({
      phase: 'incoming',
      media: 'VIDEO',
      direction: 'INCOMING',
    });
    expect(engine.current.peer).toEqual(alice);
  });

  it('accepts: opens media, answers the offer and applies early candidates in order', async () => {
    const { platform, signaling, engine } = ringing();
    signaling.replies.set('call.accept', () =>
      setup(view({ media: 'VIDEO', direction: 'INCOMING', peer: alice, status: 'ACCEPTED' })),
    );
    await engine.accept();
    expect(platform.requests).toEqual([{ audio: true, video: { facingMode: 'user' } }]);
    expect(signaling.of('call.accept')).toEqual([{ callId: 'call-1' }]);
    const peer = platform.peer();

    // A candidate that arrives before the offer is held until the description is set.
    engine.handleEvent('call.signal', {
      callId: 'call-1',
      signal: { type: 'ice', candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(peer.candidates).toEqual([]);
    engine.handleEvent('call.signal', {
      callId: 'call-1',
      signal: { type: 'offer', sdp: 'offer' },
    });
    await flush();
    expect(peer.remote).toEqual([{ type: 'offer', sdp: 'offer' }]);
    expect(peer.candidates.map((c) => c.candidate)).toEqual(['early']);
    expect(signaling.of('call.signal')).toContainEqual({
      callId: 'call-1',
      signal: { type: 'answer', sdp: 'answer-sdp' },
    });
  });

  it('declines when the camera or microphone is refused', async () => {
    const { platform, signaling, engine } = ringing();
    platform.failWith = 'NotAllowedError';
    await engine.accept();
    expect(signaling.of('call.accept')).toEqual([]);
    expect(signaling.of('call.decline')).toEqual([{ callId: 'call-1' }]);
    expect(engine.current.ending?.reason).toBe('permission_denied');
  });

  it('declines', async () => {
    const { signaling, engine } = ringing();
    await engine.decline();
    expect(signaling.of('call.decline')).toEqual([{ callId: 'call-1' }]);
    expect(engine.current.phase).toBe('idle');
  });

  it('stops ringing when answered on another device', () => {
    const { engine } = ringing();
    engine.handleEvent('call.answered_elsewhere', { callId: 'call-1' });
    expect(engine.current).toMatchObject({
      phase: 'ended',
      ending: { reason: 'answered_elsewhere' },
    });
  });

  it('reports that the other device answered first', async () => {
    const { signaling, engine } = ringing();
    signaling.replies.set('call.accept', () => ({ ok: false, error: 'answered_elsewhere' }));
    await engine.accept();
    expect(engine.current.ending?.reason).toBe('answered_elsewhere');
    expect(engine.current.localStream).toBeNull();
  });

  it('ignores a second incoming call while busy', () => {
    const { engine } = ringing();
    engine.handleEvent('call.incoming', { call: view({ id: 'call-2', direction: 'INCOMING' }) });
    expect(engine.current.call?.id).toBe('call-1');
  });

  it('cannot take calls on a device without WebRTC, and says so', async () => {
    const signaling = new FakeSignaling();
    const engine = new CallEngine(signaling, undefined, new ManualClock());
    engine.handleEvent('call.incoming', { call: view({ direction: 'INCOMING', peer: alice }) });
    expect(engine.current).toMatchObject({ phase: 'incoming', supported: false });
    await engine.accept();
    expect(engine.current.ending?.reason).toBe('unsupported');
    expect(signaling.of('call.accept')).toEqual([]);
  });
});

describe('CallEngine — during a call', () => {
  it('mutes the microphone and turns the camera off, telling the other side', async () => {
    const { platform, signaling, engine } = await outgoingConnected('VIDEO');
    const [audio, video] = platform.streams[0]?.tracks ?? [];
    engine.toggleMicrophone();
    expect(audio?.enabled).toBe(false);
    engine.toggleCamera();
    expect(video?.enabled).toBe(false);
    expect(signaling.of('call.signal').at(-1)).toEqual({
      callId: 'call-1',
      signal: { type: 'media', microphone: false, camera: false },
    });
    engine.toggleMicrophone();
    expect(audio?.enabled).toBe(true);
    expect(engine.current).toMatchObject({ microphoneMuted: false, cameraOff: true });
  });

  it('has no camera control on voice calls', async () => {
    const { engine } = await outgoingConnected('AUDIO');
    engine.toggleCamera();
    expect(engine.current.cameraOff).toBe(false);
  });

  it('shows when the other side turns their camera off', async () => {
    const { engine } = await outgoingConnected('VIDEO');
    engine.handleEvent('call.signal', {
      callId: 'call-1',
      signal: { type: 'media', microphone: true, camera: false },
    });
    expect(engine.current).toMatchObject({ remoteCameraOff: true, remoteMicrophoneMuted: false });
  });

  it('ignores stale or foreign events', async () => {
    const { peer, engine } = await outgoingConnected();
    engine.handleEvent('call.signal', { callId: 'old-call', signal: { type: 'answer', sdp: 'x' } });
    engine.handleEvent('call.ended', {
      call: view({ id: 'old-call', status: 'ENDED', outcome: 'COMPLETED' }),
      reason: 'hangup',
    });
    await flush();
    expect(peer.remote).toHaveLength(1);
    expect(engine.current.phase).toBe('active');
  });

  it('hangs up, releases media and closes the connection', async () => {
    const { platform, peer, signaling, engine } = await outgoingConnected();
    await engine.hangUp();
    expect(signaling.of('call.end')).toEqual([{ callId: 'call-1' }]);
    expect(peer.closed).toBe(true);
    expect(platform.streams[0]?.tracks.every((t) => t.stopped)).toBe(true);
    expect(engine.current).toMatchObject({ phase: 'ended', ending: { reason: 'hangup' } });
    engine.dismiss();
    expect(engine.current.phase).toBe('idle');
  });

  it('cancels an unanswered call', async () => {
    const { signaling, engine } = harness();
    signaling.replies.set('call.start', () => setup(view()));
    await engine.start('conv-1', 'AUDIO', bob);
    await engine.hangUp();
    expect(signaling.of('call.cancel')).toEqual([{ callId: 'call-1' }]);
    expect(engine.current.ending?.reason).toBe('cancelled');
  });

  it('ends when the other side hangs up, with the server’s outcome', async () => {
    const { peer, engine } = await outgoingConnected();
    engine.handleEvent('call.ended', {
      call: view({ status: 'ENDED', outcome: 'COMPLETED', durationSeconds: 61 }),
      reason: 'hangup',
    });
    expect(engine.current).toMatchObject({ phase: 'ended', ending: { outcome: 'COMPLETED' } });
    expect(engine.current.call?.durationSeconds).toBe(61);
    expect(peer.closed).toBe(true);
  });

  it('restarts ICE when media drops, and gives up if it does not recover', async () => {
    const { peer, signaling, clock, engine } = await outgoingConnected();
    peer.ice('failed');
    expect(engine.current.reconnecting).toBe(true);
    clock.advance(0);
    await flush();
    expect(peer.offers.at(-1)).toEqual({ iceRestart: true });

    clock.advance(MEDIA_RECOVERY_TIMEOUT_MS);
    await flush();
    expect(signaling.of('call.end')).toEqual([{ callId: 'call-1', reason: 'failed' }]);
    expect(engine.current.ending?.reason).toBe('failed');
  });

  it('recovers when the connection comes back, keeping the original start time', async () => {
    const { peer, clock, engine } = await outgoingConnected();
    const started = engine.current.connectedAt;
    peer.ice('disconnected');
    clock.advance(2000);
    peer.ice('connected');
    clock.advance(MEDIA_RECOVERY_TIMEOUT_MS);
    expect(engine.current).toMatchObject({
      phase: 'active',
      reconnecting: false,
      connectedAt: started,
    });
  });
});

describe('CallEngine — reconnection', () => {
  it('shows a call that started ringing while the app was away', async () => {
    const { signaling, engine } = harness();
    signaling.replies.set('call.sync', () => ({
      ok: true,
      data: { call: view({ direction: 'INCOMING', peer: alice }), onThisDevice: false },
    }));
    await engine.resync();
    expect(engine.current).toMatchObject({ phase: 'incoming', peer: alice });
  });

  it('closes a call that ended while the connection was down', async () => {
    const { signaling, engine } = await outgoingConnected();
    signaling.replies.set('call.sync', () => ({ ok: true, data: null }));
    await engine.resync();
    expect(engine.current).toMatchObject({ phase: 'ended', ending: { reason: 'disconnected' } });
  });

  it('keeps a call that is still open on this device', async () => {
    const { signaling, engine } = await outgoingConnected();
    signaling.replies.set('call.sync', () => ({
      ok: true,
      data: { call: view({ status: 'ACCEPTED' }), onThisDevice: true },
    }));
    await engine.resync();
    expect(engine.current.phase).toBe('active');
  });
});

describe('call history text', () => {
  it('describes calls from the viewer’s side', () => {
    const ended = { status: 'ENDED' as const, durationSeconds: null };
    expect(
      callDescription({
        ...ended,
        media: 'AUDIO',
        direction: 'OUTGOING',
        outcome: 'COMPLETED',
        durationSeconds: 151,
      }),
    ).toBe('Outgoing voice call · 2:31');
    expect(
      callDescription({ ...ended, media: 'VIDEO', direction: 'INCOMING', outcome: 'MISSED' }),
    ).toBe('Missed video call');
    expect(
      callDescription({ ...ended, media: 'VIDEO', direction: 'OUTGOING', outcome: 'MISSED' }),
    ).toBe('Video call · No answer');
    expect(
      callDescription({ ...ended, media: 'AUDIO', direction: 'OUTGOING', outcome: 'BUSY' }),
    ).toBe('Voice call · Busy');
    expect(callDuration(3725)).toBe('1:02:05');
  });
});
