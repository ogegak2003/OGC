import type {
  CallEndReason,
  CallSetup,
  CallSignal,
  CallView,
  ClientToServerEvents,
  ConversationView,
} from '@ogc/types';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type PushNotification, PushProvider } from '../src/modules/notifications/push-provider.js';
import {
  type TestSocket,
  connectSocket,
  eventually,
  listen,
  newDevice,
} from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  clientIp,
  createTestApp,
  makeContacts,
  nativeTokens,
  signedInUser,
} from './support/test-app.js';

class CapturingPushProvider extends PushProvider {
  readonly name = 'capture';
  readonly sent: PushNotification[] = [];
  send(notifications: PushNotification[]): Promise<undefined> {
    this.sent.push(...notifications);
    return Promise.resolve(undefined);
  }
}

type Ack<T> = { ok: true; data: T } | { ok: false; error: string };
interface Live {
  socket: TestSocket;
  events: { event: string; payload: unknown }[];
}

/** Emits a call event and resolves with the server's acknowledgement. */
function send<T>(live: Live, event: keyof ClientToServerEvents, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => {
    (live.socket.emit as (e: string, p: unknown, ack: (r: Ack<T>) => void) => void)(
      event,
      payload,
      resolve,
    );
  });
}

const received = <T>(live: Live, name: string): T[] =>
  live.events.filter((e) => e.event === name).map((e) => e.payload as T);

const SDP_MARKER = 'a=ogc-test-sdp-marker-must-not-be-logged';

/**
 * One-to-one call signaling over the realtime gateway, against a real database: who may
 * call whom, the call state machine across devices, relaying, timeouts, disconnects,
 * blocking, privacy of history, push, rate limits and log hygiene. Media itself is not
 * exercised here (no WebRTC stack in Node); see packages/messaging call-engine tests.
 */
describe('calls', () => {
  let t: TestApp;
  let baseUrl: string;
  const push = new CapturingPushProvider();
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let dave: TestUser;
  let erin: TestUser;
  let mallory: TestUser;
  let aliceBob: ConversationView;
  let carolBob: ConversationView;
  let aliceCarol: ConversationView;
  let aliceDave: ConversationView;
  let aliceErin: ConversationView;
  const sockets: TestSocket[] = [];
  const saved = { ...process.env };

  async function online(token: string): Promise<Live> {
    const connection = connectSocket(baseUrl, { token });
    sockets.push(connection.socket);
    await connection.connected;
    return connection;
  }

  /** A new session and device for `user`, connected. */
  async function device(user: TestUser): Promise<Live> {
    const { accessToken } = await nativeTokens(t, user.email);
    return online(accessToken);
  }

  async function directWith(a: TestUser, b: TestUser): Promise<ConversationView> {
    await makeContacts(t, a, b);
    const engine = await newDevice(t, baseUrl, a);
    await newDevice(t, baseUrl, b);
    return engine.client.openDirect(b.ogcId);
  }

  async function ring(
    from: Live,
    conversation: ConversationView,
    media: 'AUDIO' | 'VIDEO' = 'AUDIO',
  ) {
    const ack = await send<CallSetup>(from, 'call.start', {
      conversationId: conversation.id,
      media,
    });
    if (!ack.ok) throw new Error(`call.start failed: ${ack.error}`);
    return ack.data;
  }

  const endedFor = (live: Live, callId: string) =>
    eventually(
      () =>
        received<{ call: CallView; reason: CallEndReason }>(live, 'call.ended').find(
          (e) => e.call.id === callId,
        ),
      Boolean,
    ) as Promise<{ call: CallView; reason: CallEndReason }>;

  beforeAll(async () => {
    // Short timers so timeouts and disconnects are observable; logs on to check their content.
    process.env.CALL_RING_TIMEOUT_SECONDS = '2';
    process.env.CALL_CONNECT_TIMEOUT_SECONDS = '3';
    process.env.CALL_RECONNECT_GRACE_SECONDS = '1';
    process.env.CALL_SWEEP_INTERVAL_MS = '200';
    process.env.RATE_LIMIT_CALL_START = '20';
    process.env.LOG_LEVEL = 'debug';
    t = await createTestApp({ overrides: [{ provide: PushProvider, useValue: push }] });
    baseUrl = await listen(t);
    [alice, bob, carol, dave, erin, mallory] = await Promise.all([
      signedInUser(t, 'Alice'),
      signedInUser(t, 'Bob'),
      signedInUser(t, 'Carol'),
      signedInUser(t, 'Dave'),
      signedInUser(t, 'Erin'),
      signedInUser(t, 'Mallory'),
    ]);
    aliceBob = await directWith(alice, bob);
    carolBob = await directWith(carol, bob);
    aliceCarol = await directWith(alice, carol);
    aliceDave = await directWith(alice, dave);
    aliceErin = await directWith(alice, erin);
  });

  afterEach(async () => {
    // Every test starts with nobody in a call.
    await t.prisma.call.updateMany({
      where: { status: { not: 'ENDED' } },
      data: { status: 'ENDED', outcome: 'CANCELLED', endedAt: new Date() },
    });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await t.close();
    process.env = saved;
  });

  it('rings every device of the callee, and nobody else', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const bobTablet = await device(bob);
    const malloryLive = await device(mallory);

    const setup = await ring(aliceLive, aliceBob, 'VIDEO');
    expect(setup.call).toMatchObject({
      status: 'RINGING',
      media: 'VIDEO',
      direction: 'OUTGOING',
      conversationId: aliceBob.id,
    });
    expect(setup.call.peer.ogcId).toBe(bob.ogcId);
    expect(setup.call.peer.displayName).toBe('Bob');
    // No STUN/TURN configured: no external provider is contacted.
    expect(setup.iceServers).toEqual([]);
    expect(setup.iceTransportPolicy).toBe('all');

    for (const live of [bobPhone, bobTablet]) {
      const incoming = (await eventually(
        () => received<{ call: CallView }>(live, 'call.incoming')[0],
      )) as { call: CallView };
      expect(incoming.call).toMatchObject({
        id: setup.call.id,
        direction: 'INCOMING',
        media: 'VIDEO',
      });
      expect(incoming.call.peer).toMatchObject({ ogcId: alice.ogcId, displayName: 'Alice' });
    }
    expect(received(malloryLive, 'call.incoming')).toEqual([]);
    expect(received(aliceLive, 'call.incoming')).toEqual([]);
  });

  it('answers on one device, stops the others ringing and refuses duplicate acceptance', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const bobTablet = await device(bob);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobTablet, 'call.incoming').length > 0);

    const [first, second] = await Promise.all([
      send<CallSetup>(bobPhone, 'call.accept', { callId: call.id }),
      send<CallSetup>(bobTablet, 'call.accept', { callId: call.id }),
    ]);
    // Exactly one device wins, however the race goes.
    const wins = [first, second].filter((a) => a.ok);
    expect(wins).toHaveLength(1);
    const [winner, loser] = first.ok ? [bobPhone, bobTablet] : [bobTablet, bobPhone];
    expect([first, second].find((a) => !a.ok)).toEqual({ ok: false, error: 'answered_elsewhere' });

    await eventually(() => received<{ callId: string }>(aliceLive, 'call.accepted').length > 0);
    await eventually(() => received(loser, 'call.answered_elsewhere').length > 0);
    expect(received(winner, 'call.answered_elsewhere')).toEqual([]);
    // Accepting again from the winning device is refused too.
    expect(await send(winner, 'call.accept', { callId: call.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('relays signaling only between the two devices in the call, and never logs it', async () => {
    const aliceLive = await device(alice);
    const aliceLaptop = await device(alice);
    const bobPhone = await device(bob);
    const bobTablet = await device(bob);
    const malloryLive = await device(mallory);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    expect((await send(bobPhone, 'call.accept', { callId: call.id })).ok).toBe(true);

    const offer: CallSignal = { type: 'offer', sdp: `v=0\r\n${SDP_MARKER}\r\n` };
    expect(await send(aliceLive, 'call.signal', { callId: call.id, signal: offer })).toEqual({
      ok: true,
      data: null,
    });
    const relayed = await eventually(
      () => received<{ callId: string; signal: CallSignal }>(bobPhone, 'call.signal')[0],
    );
    expect(relayed).toEqual({ callId: call.id, signal: offer });
    expect(received(bobTablet, 'call.signal')).toEqual([]);

    // Only the caller offers and only the callee answers.
    expect(await send(bobPhone, 'call.signal', { callId: call.id, signal: offer })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const answer: CallSignal = { type: 'answer', sdp: 'v=0\r\n' };
    expect((await send(bobPhone, 'call.signal', { callId: call.id, signal: answer })).ok).toBe(
      true,
    );
    await eventually(() => received(aliceLive, 'call.signal').length > 0);

    const ice: CallSignal = {
      type: 'ice',
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 54400 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    // The caller's other device, the callee's other device and strangers cannot inject.
    expect(await send(aliceLaptop, 'call.signal', { callId: call.id, signal: ice })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await send(bobTablet, 'call.signal', { callId: call.id, signal: ice })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await send(malloryLive, 'call.signal', { callId: call.id, signal: ice })).toEqual({
      ok: false,
      error: 'not_found',
    });
    // Forged identity fields are refused outright.
    expect(
      await send(aliceLive, 'call.signal', { callId: call.id, signal: ice, from: bob.ogcId }),
    ).toEqual({ ok: false, error: 'invalid' });

    expect(t.logs()).not.toContain(SDP_MARKER);
    expect(t.logs()).not.toContain('192.0.2.10');
  });

  it('measures a completed call from connection and refuses stale signaling afterwards', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    await send(bobPhone, 'call.accept', { callId: call.id });
    expect(await send(aliceLive, 'call.connected', { callId: call.id })).toEqual({
      ok: true,
      data: null,
    });
    // A second report does not restart the clock.
    await send(bobPhone, 'call.connected', { callId: call.id });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await send(bobPhone, 'call.end', { callId: call.id })).toEqual({ ok: true, data: null });

    const forAlice = await endedFor(aliceLive, call.id);
    const forBob = await endedFor(bobPhone, call.id);
    expect(forAlice.reason).toBe('hangup');
    expect(forAlice.call).toMatchObject({ outcome: 'COMPLETED', direction: 'OUTGOING' });
    expect(forBob.call).toMatchObject({ outcome: 'COMPLETED', direction: 'INCOMING' });
    expect(forAlice.call.durationSeconds).toBeGreaterThanOrEqual(1);

    // Replayed or late events for the ended call are refused.
    const offer = { type: 'offer', sdp: 'v=0' };
    expect(await send(aliceLive, 'call.signal', { callId: call.id, signal: offer })).toEqual({
      ok: false,
      error: 'ended',
    });
    expect(await send(bobPhone, 'call.accept', { callId: call.id })).toEqual({
      ok: false,
      error: 'ended',
    });
    expect(await send(aliceLive, 'call.end', { callId: call.id })).toEqual({
      ok: false,
      error: 'ended',
    });
  });

  it('declines and cancels', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const bobTablet = await device(bob);

    const declined = (await ring(aliceLive, aliceBob)).call;
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    expect(await send(bobTablet, 'call.decline', { callId: declined.id })).toEqual({
      ok: true,
      data: null,
    });
    expect((await endedFor(aliceLive, declined.id)).call.outcome).toBe('DECLINED');
    // The other device stops ringing too.
    expect((await endedFor(bobPhone, declined.id)).reason).toBe('declined');

    const cancelled = (await ring(aliceLive, aliceBob)).call;
    await eventually(() =>
      received<{ call: CallView }>(bobPhone, 'call.incoming').some(
        (e) => e.call.id === cancelled.id,
      ),
    );
    // The callee's "cancel" while ringing cannot pose as the caller's: it counts as a decline.
    expect(await send(bobPhone, 'call.cancel', { callId: cancelled.id })).toEqual({
      ok: true,
      data: null,
    });
    const ended = await endedFor(aliceLive, cancelled.id);
    // A callee's hang-up while ringing is a decline.
    expect(ended.call.outcome).toBe('DECLINED');

    const third = (await ring(aliceLive, aliceBob)).call;
    expect(await send(aliceLive, 'call.cancel', { callId: third.id })).toEqual({
      ok: true,
      data: null,
    });
    const cancelledForBob = await endedFor(bobPhone, third.id);
    expect(cancelledForBob).toMatchObject({ reason: 'cancelled', call: { outcome: 'CANCELLED' } });
  });

  it('reports busy and prevents a second call for the same person', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const carolLive = await device(carol);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    await send(bobPhone, 'call.accept', { callId: call.id });

    const busy = await ring(carolLive, carolBob);
    expect(busy.call).toMatchObject({ status: 'ENDED', outcome: 'BUSY' });
    // Bob's phone did not ring for Carol's call.
    expect(
      received<{ call: CallView }>(bobPhone, 'call.incoming').filter(
        (e) => e.call.id === busy.call.id,
      ),
    ).toEqual([]);

    // Alice is in a call: she cannot start another (no duplicate sessions).
    expect(
      await send(aliceLive, 'call.start', { conversationId: aliceCarol.id, media: 'AUDIO' }),
    ).toEqual({ ok: false, error: 'in_call' });
  });

  it('ends unanswered calls as missed, and pushes generic texts to offline devices', async () => {
    push.sent.length = 0;
    const offline = await nativeTokens(t, bob.email);
    await request(t.server)
      .put('/api/v1/notifications/push-token')
      .set('Authorization', `Bearer ${offline.accessToken}`)
      .set('X-Forwarded-For', clientIp())
      .send({ provider: 'EXPO', token: 'ExponentPushToken[bob-offline-device]' })
      .expect(204);
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);

    const { call } = await ring(aliceLive, aliceBob, 'VIDEO');
    const ended = await endedFor(aliceLive, call.id);
    expect(ended).toMatchObject({ reason: 'timeout', call: { outcome: 'MISSED' } });
    expect((await endedFor(bobPhone, call.id)).call.outcome).toBe('MISSED');

    const pushes = await eventually(
      () => push.sent.filter((p) => p.data.type === 'call'),
      (list) => list.length >= 2,
    );
    expect(pushes.map((p) => p.body).sort()).toEqual(['Incoming call', 'Missed call']);
    expect(pushes.every((p) => p.token === 'ExponentPushToken[bob-offline-device]')).toBe(true);
    // Never the caller's name, OGC ID or the call type.
    const serialized = JSON.stringify(pushes);
    for (const secret of ['Alice', alice.ogcId, 'VIDEO']) expect(serialized).not.toContain(secret);
  });

  it('fails answered calls whose media never connects', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    await send(bobPhone, 'call.accept', { callId: call.id });
    const ended = await endedFor(aliceLive, call.id);
    expect(ended).toMatchObject({ reason: 'failed', call: { outcome: 'FAILED' } });
  });

  it('ends the call when a device stays disconnected past the grace period', async () => {
    const aliceLive = await device(alice);
    const bobPhone = await device(bob);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    await send(bobPhone, 'call.accept', { callId: call.id });
    await send(aliceLive, 'call.connected', { callId: call.id });
    bobPhone.socket.disconnect();
    const ended = await endedFor(aliceLive, call.id);
    expect(ended).toMatchObject({ reason: 'disconnected', call: { outcome: 'COMPLETED' } });
  });

  it('restores an open call after reconnecting', async () => {
    const aliceLive = await device(alice);
    const { accessToken } = await nativeTokens(t, bob.email);
    const bobPhone = await online(accessToken);
    const { call } = await ring(aliceLive, aliceBob);
    await eventually(() => received(bobPhone, 'call.incoming').length > 0);
    await send(bobPhone, 'call.accept', { callId: call.id });
    await send(aliceLive, 'call.connected', { callId: call.id });

    // Bob's connection drops and comes back on the same device within the grace period.
    bobPhone.socket.disconnect();
    const again = await online(accessToken);
    const sync = await send<{ call: CallView; onThisDevice: boolean } | null>(
      again,
      'call.sync',
      {},
    );
    expect(sync).toMatchObject({ ok: true, data: { onThisDevice: true, call: { id: call.id } } });
    // Another of Bob's devices sees the call, but not as its own.
    const tablet = await device(bob);
    expect(await send(tablet, 'call.sync', {})).toMatchObject({
      ok: true,
      data: { onThisDevice: false },
    });
    // And the call survives the grace period.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect((await t.prisma.call.findUniqueOrThrow({ where: { id: call.id } })).status).toBe(
      'ACCEPTED',
    );
    // Someone else's open call is invisible.
    expect(await send(await device(mallory), 'call.sync', {})).toEqual({ ok: true, data: null });
  });

  it('never rings someone who blocked the caller, and does not reveal the block', async () => {
    const blocked = await dave.as(request(t.server).post(`/api/v1/blocks/${alice.ogcId}`));
    expect(blocked.status).toBeLessThan(300);
    const aliceLive = await device(alice);
    const daveLive = await device(dave);
    const { call } = await ring(aliceLive, aliceDave);
    // For Alice it looks like any call: ringing, then no answer.
    expect(call.status).toBe('RINGING');
    const ended = await endedFor(aliceLive, call.id);
    expect(ended.call.outcome).toBe('MISSED');
    expect(received(daveLive, 'call.incoming')).toEqual([]);
    expect(received(daveLive, 'call.ended')).toEqual([]);
    // Dave cannot see or act on the call, and it is not in his history.
    expect(await send(daveLive, 'call.accept', { callId: call.id })).toEqual({
      ok: false,
      error: 'not_found',
    });
    const history = await dave.as(request(t.server).get('/api/v1/calls')).expect(200);
    expect((history.body as { items: CallView[] }).items.map((c) => c.id)).not.toContain(call.id);
    // Dave, who blocked Alice, cannot call her either.
    expect(
      await send(daveLive, 'call.start', { conversationId: aliceDave.id, media: 'AUDIO' }),
    ).toEqual({ ok: false, error: 'unavailable' });
  });

  it('ends a call when one participant blocks the other, as an ordinary hang-up', async () => {
    const aliceLive = await device(alice);
    const carolLive = await device(carol);
    const { call } = await ring(aliceLive, aliceCarol);
    await eventually(() => received(carolLive, 'call.incoming').length > 0);
    await send(carolLive, 'call.accept', { callId: call.id });
    await send(aliceLive, 'call.connected', { callId: call.id });
    await carol.as(request(t.server).post(`/api/v1/blocks/${alice.ogcId}`));
    const ended = await endedFor(aliceLive, call.id);
    expect(ended).toMatchObject({ reason: 'hangup', call: { outcome: 'COMPLETED' } });
    await carol.as(request(t.server).delete(`/api/v1/blocks/${alice.ogcId}`));
  });

  it('refuses calls to inactive accounts and outside a direct conversation', async () => {
    await t.prisma.user.update({ where: { id: erin.userId }, data: { status: 'SUSPENDED' } });
    const aliceLive = await device(alice);
    expect(
      await send(aliceLive, 'call.start', { conversationId: aliceErin.id, media: 'AUDIO' }),
    ).toEqual({ ok: false, error: 'unavailable' });
    // Mallory is not a participant: indistinguishable from a conversation that does not exist.
    const malloryLive = await device(mallory);
    expect(
      await send(malloryLive, 'call.start', { conversationId: aliceBob.id, media: 'AUDIO' }),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(
      await send(malloryLive, 'call.start', {
        conversationId: '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f',
        media: 'AUDIO',
      }),
    ).toEqual({ ok: false, error: 'not_found' });
  });

  it('keeps call history private to the participants', async () => {
    const aliceLive = await device(alice);
    const { call } = await ring(aliceLive, aliceBob);
    await send(aliceLive, 'call.cancel', { callId: call.id });
    const mine = await alice
      .as(request(t.server).get('/api/v1/calls'))
      .query({ conversationId: aliceBob.id, limit: 5 })
      .expect(200);
    const items = (mine.body as { items: CallView[] }).items;
    expect(items[0]).toMatchObject({ id: call.id, outcome: 'CANCELLED', direction: 'OUTGOING' });
    const bobs = await bob
      .as(request(t.server).get('/api/v1/calls'))
      .query({ conversationId: aliceBob.id })
      .expect(200);
    expect((bobs.body as { items: CallView[] }).items[0]).toMatchObject({
      id: call.id,
      direction: 'INCOMING',
    });
    await mallory
      .as(request(t.server).get('/api/v1/calls'))
      .query({ conversationId: aliceBob.id })
      .expect(404);
    const malloryAll = await mallory.as(request(t.server).get('/api/v1/calls')).expect(200);
    expect((malloryAll.body as { items: CallView[] }).items).toEqual([]);
    await request(t.server).get('/api/v1/calls').expect(401);
  });

  it('rate-limits call creation and rejects malformed events', async () => {
    const malloryLive = await device(mallory);
    expect(await send(malloryLive, 'call.start', { conversationId: 'x', media: 'AUDIO' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const results = [];
    for (let i = 0; i < 22; i++) {
      results.push(
        await send(malloryLive, 'call.start', { conversationId: aliceBob.id, media: 'AUDIO' }),
      );
    }
    expect(results.at(-1)).toEqual({ ok: false, error: 'rate_limited' });
  });
});
