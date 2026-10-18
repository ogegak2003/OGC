import { rawKeySealer } from '@ogc/e2ee';
import {
  type EngineTimers,
  MemoryKeyValueStore,
  MessagingClient,
  SealedStore,
  TransportError,
} from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTransport, eventually, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  nativeTokens,
  signedInUser,
} from './support/test-app.js';

/**
 * While a conversation's resync is rate-limited (`MLS_RESYNC_RATE_LIMITED`), its outgoing
 * messages stay pending in the sealed outbox: no request until the pause ends, one recovery
 * attempt then, and the queue is sent exactly once after recovery. Timers are a manual clock.
 */
class ManualTimers implements EngineTimers {
  private time = Date.now();
  private nextId = 1;
  readonly active = new Map<number, { at: number; ms: number; callback: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.active.set(id, { at: this.time + ms, ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.active.delete(handle as number);
  }
  /** Moves the clock and fires what became due. */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.active]) {
      if (timer.at <= this.time) {
        this.active.delete(id);
        timer.callback();
      }
    }
  }
  only(): { at: number; ms: number } {
    expect(this.active.size).toBe(1);
    const [timer] = [...this.active.values()];
    if (!timer) throw new Error('no timer');
    return timer;
  }
}

describe('pending messages during a rate-limited MLS resync', () => {
  let t: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
  });

  afterAll(async () => {
    await t.close();
  });

  interface Device {
    transport: HttpTransport;
    store: SealedStore;
    client: MessagingClient;
  }

  /** An engine with a manual clock (optionally on an existing device's transport and storage). */
  async function engineFor(
    user: TestUser,
    timers: ManualTimers,
    existing?: Device,
  ): Promise<Device> {
    const transport =
      existing?.transport ??
      new HttpTransport(baseUrl, (await nativeTokens(t, user.email)).accessToken);
    const store =
      existing?.store ??
      new SealedStore(
        new MemoryKeyValueStore(),
        rawKeySealer(crypto.getRandomValues(new Uint8Array(32))),
      );
    const client = new MessagingClient(transport, store, user.ogcId, timers);
    await client.start();
    return { transport, store, client };
  }

  function count(device: Device) {
    const calls = new Map<string, number>();
    const bump = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
    const { mlsGroup, submitCommit, sendMessage } = device.transport;
    device.transport.mlsGroup = (id) => {
      bump(`lookup:${id}`);
      return mlsGroup(id);
    };
    device.transport.submitCommit = (id, body) => {
      bump(`commit:${id}`);
      return submitCommit(id, body);
    };
    device.transport.sendMessage = (id, body) => {
      bump(`send:${id}`);
      return sendMessage(id, body);
    };
    return (kind: 'lookup' | 'commit' | 'send', id: string) => calls.get(`${kind}:${id}`) ?? 0;
  }

  /** A group with this engine and a second device of the account (so it is not a sole member). */
  async function group(user: TestUser, device: Device, name: string): Promise<string> {
    const created = await user
      .as(request(t.server).post('/api/v1/groups'))
      .send({ name })
      .expect(201);
    const id = (created.body as { conversation: ConversationView }).conversation.id;
    await device.client.refreshConversations();
    await device.client.send(id, { text: `${name} created` });
    const second = await newDevice(t, baseUrl, user);
    await second.client.syncConversation(id);
    return id;
  }

  const states = async (client: MessagingClient, id: string) =>
    (await client.messages(id))
      .filter((m) => m.mine)
      .map((m) => `${m.payload?.text ?? ''}:${m.state}`);
  const loseState = (device: Device, id: string) => device.store.delete(`group:${id}`);
  const serverTexts = async (id: string) =>
    await t.prisma.message.count({ where: { conversationId: id } });

  it('keeps sends pending through the pause, then delivers them exactly once', async () => {
    const user = await signedInUser(t, 'Paused');
    const timers = new ManualTimers();
    const device = await engineFor(user, timers);
    const id = await group(user, device, 'Paused');
    const other = await group(user, device, 'Other');
    const calls = count(device);

    // Use up the per-conversation allowance (3 resyncs), then lose state once more.
    for (let i = 0; i < 3; i++) {
      await loseState(device, id);
      expect((await device.client.send(id, { text: `resync ${String(i)}` })).state).toBe('ok');
    }
    const onServer = await serverTexts(id);
    await loseState(device, id);
    const first = await device.client.send(id, { text: 'p1' });
    expect(first.state).toBe('pending');
    expect(device.client.resyncPausedUntil(id)).toBeDefined();
    const pause = timers.only();
    expect(pause.ms).toBeGreaterThan(500_000); // the server's Retry-After (~10 minutes)

    // During the pause: more sends stay pending; no lookup, commit or send for this conversation.
    const before = {
      lookup: calls('lookup', id),
      commit: calls('commit', id),
      send: calls('send', id),
    };
    expect((await device.client.send(id, { text: 'p2' })).state).toBe('pending');
    expect((await device.client.send(id, { text: 'p3' })).state).toBe('pending');
    await expect(device.client.syncConversation(id)).rejects.toThrow(/paused/);
    await device.client.flushOutbox();
    await device.client.syncAll();
    expect({
      lookup: calls('lookup', id),
      commit: calls('commit', id),
      send: calls('send', id),
    }).toEqual(before);
    // One timer, unchanged: repeated sends neither add timers nor extend the window.
    expect(timers.only()).toEqual(pause);
    expect(await states(device.client, id)).toEqual(
      expect.arrayContaining(['p1:pending', 'p2:pending', 'p3:pending']),
    );
    expect(await serverTexts(id)).toBe(onServer);

    // Other conversations send and flush normally meanwhile.
    expect((await device.client.send(other, { text: 'unaffected' })).state).toBe('ok');

    // The pause ends but the server still limits: the pause is renewed from the new answer.
    timers.advance(pause.ms);
    await eventually(
      () => calls('commit', id),
      (n) => n === before.commit + 1,
      15_000,
    );
    await eventually(
      () => timers.active.size,
      (n) => n === 1,
      15_000,
    );
    const renewed = timers.only();
    expect(renewed.at).toBeGreaterThan(pause.at);
    expect(await states(device.client, id)).toEqual(
      expect.arrayContaining(['p1:pending', 'p2:pending', 'p3:pending']),
    );

    // The window has passed on the server: the next attempt recovers and sends the queue once.
    await t.prisma
      .$executeRaw`UPDATE mls_commits SET created_at = created_at - interval '11 minutes'
      WHERE conversation_id = ${id}::uuid AND resync`;
    timers.advance(renewed.ms);
    await eventually(
      async () => (await states(device.client, id)).filter((s) => s.endsWith(':pending')).length,
      (n) => n === 0,
      15_000,
    );
    expect(await serverTexts(id)).toBe(onServer + 3);
    expect(calls('send', id)).toBe(before.send + 3);
    for (const text of ['p1', 'p2', 'p3']) {
      expect(await states(device.client, id)).toContain(`${text}:ok`);
    }
    expect(timers.active.size).toBe(0);
    expect(device.client.resyncPausedUntil(id)).toBeUndefined();
  }, 120_000);

  it('falls back to 60 s without Retry-After, and treats other 429s and errors as before', async () => {
    const user = await signedInUser(t, 'Edges');
    const timers = new ManualTimers();
    const device = await engineFor(user, timers);
    const id = await group(user, device, 'Edges');
    const calls = count(device);
    const { submitCommit, sendMessage } = device.transport;

    // A resync limit without (or with an unreadable) Retry-After: the 60 s fallback, one timer.
    device.transport.submitCommit = () =>
      Promise.reject(new TransportError('Limited', 429, 'MLS_RESYNC_RATE_LIMITED', undefined));
    await loseState(device, id);
    expect((await device.client.send(id, { text: 'no header' })).state).toBe('pending');
    expect(timers.only().ms).toBe(60_000);
    const commits = calls('commit', id);
    await device.client.send(id, { text: 'still paused' });
    await expect(device.client.syncConversation(id)).rejects.toThrow(/paused/);
    expect(calls('commit', id)).toBe(commits);
    expect(timers.active.size).toBe(1);

    // Recovery after the fallback: both queued messages go out once.
    device.transport.submitCommit = submitCommit;
    timers.advance(60_000);
    await eventually(
      async () => (await states(device.client, id)).filter((s) => s.endsWith(':pending')).length,
      (n) => n === 0,
      15_000,
    );
    expect(await states(device.client, id)).toEqual(
      expect.arrayContaining(['no header:ok', 'still paused:ok']),
    );

    // The general request throttle (429 RATE_LIMITED) is no resync pause.
    device.transport.submitCommit = () =>
      Promise.reject(new TransportError('Too many requests', 429, 'RATE_LIMITED', 30));
    await loseState(device, id);
    await expect(device.client.send(id, { text: 'throttled' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(device.client.resyncPausedUntil(id)).toBeUndefined();
    expect(timers.active.size).toBe(0);
    // Unchanged existing behavior: a retryable failure stays pending (not failed).
    expect(await states(device.client, id)).toContain('throttled:pending');
    device.transport.submitCommit = submitCommit;
    await device.client.flushOutbox();
    expect(await states(device.client, id)).toContain('throttled:ok');

    // Permanent errors still fail the message.
    for (const [status, code] of [
      [403, 'FORBIDDEN'],
      [400, 'VALIDATION_FAILED'],
      [400, 'INVALID_MLS_MESSAGE'],
    ] as const) {
      device.transport.sendMessage = () => Promise.reject(new TransportError('No', status, code));
      await expect(device.client.send(id, { text: `permanent ${code}` })).rejects.toMatchObject({
        code,
      });
      expect(await states(device.client, id)).toContain(`permanent ${code}:failed`);
      expect(device.client.resyncPausedUntil(id)).toBeUndefined();
    }
    device.transport.sendMessage = sendMessage;
  }, 120_000);

  it('after a restart, keeps the persisted queue pending and sends nothing without a group', async () => {
    const user = await signedInUser(t, 'Restart');
    const timers = new ManualTimers();
    const device = await engineFor(user, timers);
    const id = await group(user, device, 'Restart');
    const { submitCommit } = device.transport;
    device.transport.submitCommit = () =>
      Promise.reject(new TransportError('Limited', 429, 'MLS_RESYNC_RATE_LIMITED', 120));
    await loseState(device, id);
    expect((await device.client.send(id, { text: 'queued' })).state).toBe('pending');

    // The app restarts: the pause was in memory only, the queue is in the sealed store.
    const restartTimers = new ManualTimers();
    const restarted = await engineFor(user, restartTimers, device);
    const calls = count(restarted);
    expect(restarted.client.resyncPausedUntil(id)).toBeUndefined();
    await restarted.client.flushOutbox(); // one attempt rediscovers the pause
    expect(calls('commit', id)).toBe(1);
    expect(calls('send', id)).toBe(0);
    expect(restartTimers.only().ms).toBe(120_000);
    await restarted.client.flushOutbox();
    expect(calls('commit', id)).toBe(1);
    expect(await states(restarted.client, id)).toContain('queued:pending');

    device.transport.submitCommit = submitCommit;
    restartTimers.advance(120_000);
    await eventually(
      async () => states(restarted.client, id),
      (list) => list.includes('queued:ok'),
      15_000,
    );
    expect(calls('send', id)).toBe(1);
    await restarted.client.wipe();
  }, 120_000);
});
