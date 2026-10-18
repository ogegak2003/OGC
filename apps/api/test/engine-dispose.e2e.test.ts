import { rawKeySealer } from '@ogc/e2ee';
import {
  EngineDisposedError,
  type EngineTimers,
  MemoryKeyValueStore,
  MessagingClient,
  SealedStore,
  TransportError,
} from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTransport, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  nativeTokens,
  signedInUser,
} from './support/test-app.js';

/**
 * Engine shutdown (`dispose()`): retry timers are cleared, work in flight stops at its next
 * request, nothing is scheduled afterwards, and queued messages survive for the next engine.
 * Real API and MLS; a manual clock; in-flight requests are held by explicit gates.
 */
class ManualTimers implements EngineTimers {
  private time = Date.now();
  private nextId = 1;
  readonly active = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.active.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.active.delete(handle as number);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.active]) {
      if (timer.at <= this.time) {
        this.active.delete(id);
        timer.callback();
      }
    }
  }
}

/** A promise the test resolves when it chooses. */
function gate<T>() {
  let open: (value: T) => void = () => undefined;
  const opened = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe('messaging engine dispose', () => {
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

  async function engineFor(
    user: TestUser,
    timers: ManualTimers,
    existing?: Pick<Device, 'transport' | 'store'>,
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

  /** A group with this engine and a second device of the account (not a sole member). */
  async function group(user: TestUser, device: Device, name: string): Promise<string> {
    const created = await user
      .as(request(t.server).post('/api/v1/groups'))
      .send({ name })
      .expect(201);
    const id = (created.body as { conversation: ConversationView }).conversation.id;
    await device.client.refreshConversations();
    await device.client.send(id, { text: `${name} created` });
    await (await newDevice(t, baseUrl, user)).client.syncConversation(id);
    return id;
  }

  const states = async (client: MessagingClient, id: string) =>
    (await client.messages(id))
      .filter((m) => m.mine && m.state !== 'ok')
      .map((m) => `${m.payload?.text ?? ''}:${m.state}`);
  const serverCount = (id: string) => t.prisma.message.count({ where: { conversationId: id } });

  it('clears a pending resync timer, and its expiry then does nothing', async () => {
    const user = await signedInUser(t, 'Timer');
    const timers = new ManualTimers();
    const device = await engineFor(user, timers);
    const id = await group(user, device, 'Timer');
    const { submitCommit } = device.transport;
    let commits = 0;
    device.transport.submitCommit = () => {
      commits++;
      return Promise.reject(new TransportError('Limited', 429, 'MLS_RESYNC_RATE_LIMITED', 120));
    };
    await device.store.delete(`group:${id}`);
    expect((await device.client.send(id, { text: 'queued' })).state).toBe('pending');
    expect(timers.active.size).toBe(1);

    device.client.dispose();
    device.client.dispose(); // idempotent
    expect(timers.active.size).toBe(0);
    expect(device.client.resyncPausedUntil(id)).toBeUndefined();
    timers.advance(120_000);
    await Promise.resolve();
    expect(commits).toBe(1);
    expect(await states(device.client, id)).toEqual(['queued:pending']);
    device.transport.submitCommit = submitCommit;
  }, 120_000);

  it('stops a recovery in flight: no new timer, no send, the message stays pending', async () => {
    const user = await signedInUser(t, 'InFlight');
    const timers = new ManualTimers();
    const device = await engineFor(user, timers);
    const id = await group(user, device, 'InFlight');
    const { submitCommit, sendMessage } = device.transport;
    let sends = 0;
    device.transport.sendMessage = (conversationId, body) => {
      sends++;
      return sendMessage(conversationId, body);
    };

    // 1. The resync commit is in flight when the engine is disposed; it then answers 429.
    const limited = gate<true>();
    const reachedCommit = gate<true>();
    device.transport.submitCommit = async () => {
      reachedCommit.open(true);
      await limited.opened;
      throw new TransportError('Limited', 429, 'MLS_RESYNC_RATE_LIMITED', 60);
    };
    await device.store.delete(`group:${id}`);
    const sending = device.client.send(id, { text: 'during 429' });
    await reachedCommit.opened;
    device.client.dispose();
    limited.open(true);
    const result = await sending;
    expect(result.state).toBe('pending');
    expect(timers.active.size).toBe(0); // the late 429 schedules nothing
    expect(sends).toBe(0);
    expect(await states(device.client, id)).toEqual(['during 429:pending']);

    // 2. Same, but the resync then succeeds: the encrypted send is refused, nothing is flushed.
    const second = await engineFor(user, timers, device);
    const accepted = gate<true>();
    const reached = gate<true>();
    device.transport.submitCommit = async (conversationId, body) => {
      reached.open(true);
      await accepted.opened;
      return submitCommit(conversationId, body);
    };
    await second.store.delete(`group:${id}`);
    const before = await serverCount(id);
    const sendingAgain = second.client.send(id, { text: 'during success' });
    await reached.opened;
    second.client.dispose();
    accepted.open(true);
    await expect(sendingAgain).rejects.toBeInstanceOf(EngineDisposedError);
    await Promise.resolve();
    expect(sends).toBe(0);
    expect(await serverCount(id)).toBe(before);
    expect(timers.active.size).toBe(0);
    // Both queued messages are still pending (never marked failed).
    expect((await states(second.client, id)).sort()).toEqual([
      'during 429:pending',
      'during success:pending',
    ]);

    // 3. A new engine on the same device storage sends the queue, each message once.
    device.transport.submitCommit = submitCommit;
    const third = await engineFor(user, new ManualTimers(), device);
    expect(await third.client.flushOutbox()).toBe(2);
    expect(await states(third.client, id)).toEqual([]);
    expect(await serverCount(id)).toBe(before + 2);
    expect(sends).toBe(2);
    await third.client.wipe();
  }, 120_000);
});
