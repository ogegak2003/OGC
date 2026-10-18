import { MessagingClient, TransportError } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDevice, listen, newDevice } from './support/messaging.js';
import { type TestApp, type TestUser, createTestApp, signedInUser } from './support/test-app.js';

/**
 * The sealed outbox under concurrency: every change to a conversation's outbox record is
 * serialized, so simultaneous sends, deliveries, discards and syncs never overwrite each other.
 * Also: a general 429 while flushing skips only that conversation. Real API and MLS.
 */
describe('outbox concurrency and flushing', () => {
  let t: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
  });

  afterAll(async () => {
    await t.close();
  });

  async function group(user: TestUser, device: TestDevice, name: string, alone = false) {
    const created = await user
      .as(request(t.server).post('/api/v1/groups'))
      .send({ name })
      .expect(201);
    const id = (created.body as { conversation: ConversationView }).conversation.id;
    await device.client.refreshConversations();
    await device.client.send(id, { text: `${name} created` });
    if (!alone) await (await newDevice(t, baseUrl, user)).client.syncConversation(id);
    return id;
  }

  const outbox = async (client: MessagingClient, id: string) =>
    (await client.messages(id))
      .filter((m) => m.state === 'pending' || m.state === 'failed')
      .map((m) => `${m.payload?.text ?? ''}:${m.state}`);
  const serverCount = (id: string) => t.prisma.message.count({ where: { conversationId: id } });
  const offline = () => Promise.reject(new TransportError('Network error', 0));
  const five = (prefix: string) => [1, 2, 3, 4, 5].map((n) => `${prefix}${String(n)}`);

  it('keeps all of five simultaneous sends while waiting for another device (and after reload)', async () => {
    const user = await signedInUser(t, 'Waiting');
    const phone = await newDevice(t, baseUrl, user);
    const id = await group(user, phone, 'Waiting', true);
    await phone.store.delete(`group:${id}`); // sole member without state: messages stay queued

    // The case the review reproduced (1 of 5 kept), three rounds.
    for (let round = 0; round < 3; round++) {
      const texts = five(`w${String(round)}-`);
      const sent = await Promise.all(texts.map((text) => phone.client.send(id, { text })));
      expect(sent.map((m) => m.state)).toEqual(Array(5).fill('pending'));
      const queued = await outbox(phone.client, id);
      for (const text of texts) expect(queued).toContain(`${text}:pending`);
    }
    expect(await outbox(phone.client, id)).toHaveLength(15);

    // Reload: a new engine on the same sealed storage sees the same 15 queued messages.
    const reloaded = new MessagingClient(phone.transport, phone.store, user.ogcId);
    await reloaded.start();
    expect(await outbox(reloaded, id)).toEqual(await outbox(phone.client, id));
    await reloaded.wipe();
  }, 120_000);

  it('keeps all of five simultaneous sends while the resync is rate-limited', async () => {
    const user = await signedInUser(t, 'Paused');
    const phone = await newDevice(t, baseUrl, user);
    const id = await group(user, phone, 'Paused');
    const { submitCommit } = phone.transport;
    phone.transport.submitCommit = () =>
      Promise.reject(new TransportError('Limited', 429, 'MLS_RESYNC_RATE_LIMITED', 600));
    await phone.store.delete(`group:${id}`);

    const texts = five('p');
    const sent = await Promise.all(texts.map((text) => phone.client.send(id, { text })));
    expect(sent.map((m) => m.state)).toEqual(Array(5).fill('pending'));
    expect(phone.client.resyncPausedUntil(id)).toBeDefined();
    expect((await outbox(phone.client, id)).sort()).toEqual(texts.map((x) => `${x}:pending`));
    phone.transport.submitCommit = submitCommit;
    await phone.client.wipe(); // clears the pause timer
  }, 120_000);

  it('keeps all of five simultaneous sends while offline, and sends each once later', async () => {
    const user = await signedInUser(t, 'Offline');
    const phone = await newDevice(t, baseUrl, user);
    const id = await group(user, phone, 'Offline');
    const { directory, sendMessage } = phone.transport;
    phone.transport.directory = offline;
    phone.transport.sendMessage = offline;

    const texts = five('o');
    const results = await Promise.allSettled(texts.map((text) => phone.client.send(id, { text })));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect((await outbox(phone.client, id)).sort()).toEqual(texts.map((x) => `${x}:pending`));

    phone.transport.directory = directory;
    phone.transport.sendMessage = sendMessage;
    const before = await serverCount(id);
    expect(await phone.client.flushOutbox()).toBe(5);
    expect(await outbox(phone.client, id)).toEqual([]);
    expect(await serverCount(id)).toBe(before + 5);
    // Flushing again sends nothing more.
    expect(await phone.client.flushOutbox()).toBe(0);
    expect(await serverCount(id)).toBe(before + 5);
  }, 120_000);

  it('never loses a new send, nor revives a sent one, when it races a delivery', async () => {
    const user = await signedInUser(t, 'Race');
    const phone = await newDevice(t, baseUrl, user);
    const id = await group(user, phone, 'Race');
    const { sendMessage } = phone.transport;

    // The first submission (A's): once the server has accepted A — just before A's delivery
    // removes it from the outbox — B is sent. B's own delivery comes later and finds the device
    // offline, so B must stay queued. Both outbox writes race; any order must keep B, not A.
    let calls = 0;
    let bSend: Promise<unknown> = Promise.resolve();
    phone.transport.sendMessage = async (conversationId, body) => {
      const answer = await sendMessage(conversationId, body);
      if (calls++ === 0) {
        phone.transport.directory = offline;
        bSend = phone.client.send(id, { text: 'B' }).catch(() => undefined);
      }
      return answer;
    };
    const before = await serverCount(id);
    expect((await phone.client.send(id, { text: 'A' })).state).toBe('ok');
    await bSend;

    const queued = await outbox(phone.client, id);
    expect(queued).toEqual(['B:pending']); // B kept, A not revived
    expect(await serverCount(id)).toBe(before + 1);
  }, 120_000);

  it('keeps concurrent discards and new sends from overwriting each other', async () => {
    const user = await signedInUser(t, 'Discard');
    const phone = await newDevice(t, baseUrl, user);
    const id = await group(user, phone, 'Discard');
    const { sendMessage } = phone.transport;
    phone.transport.sendMessage = () =>
      Promise.reject(new TransportError('Forbidden', 403, 'FORBIDDEN'));
    for (const text of ['f1', 'f2', 'f3']) {
      await expect(phone.client.send(id, { text })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const failed = (await phone.client.messages(id)).filter((m) => m.state === 'failed');
    expect(failed).toHaveLength(3);
    const [f1, f2] = failed;
    phone.transport.sendMessage = offline;

    await Promise.allSettled([
      phone.client.discardFailed(id, f1?.clientMessageId ?? ''),
      phone.client.discardFailed(id, f2?.clientMessageId ?? ''),
      phone.client.send(id, { text: 'new' }),
    ]);
    expect((await outbox(phone.client, id)).sort()).toEqual(['f3:failed', 'new:pending']);
    phone.transport.sendMessage = sendMessage;
  }, 120_000);

  it('skips only the throttled conversation when flushing, and stops when offline', async () => {
    const user = await signedInUser(t, 'Flush');
    const phone = await newDevice(t, baseUrl, user);
    const throttled = await group(user, phone, 'Throttled');
    const other = await group(user, phone, 'Other');
    const { sendMessage } = phone.transport;

    // Queue one message in each conversation while offline (throttled first).
    phone.transport.sendMessage = offline;
    await phone.client.send(throttled, { text: 't1' }).catch(() => undefined);
    await phone.client.send(other, { text: 'o1' }).catch(() => undefined);

    // Offline: the flush stops at the first conversation; the second is not even tried.
    const attempts = new Map<string, number>();
    phone.transport.sendMessage = (conversationId) => {
      attempts.set(conversationId, (attempts.get(conversationId) ?? 0) + 1);
      return offline();
    };
    expect(await phone.client.flushOutbox()).toBe(0);
    expect(attempts.get(throttled)).toBe(1);
    expect(attempts.get(other)).toBeUndefined();

    // The general throttle on one conversation: it stays pending, the other is sent.
    phone.transport.sendMessage = (conversationId, body) =>
      conversationId === throttled
        ? Promise.reject(new TransportError('Too many requests', 429, 'RATE_LIMITED', 30))
        : sendMessage(conversationId, body);
    expect(await phone.client.flushOutbox()).toBe(1);
    expect(await outbox(phone.client, throttled)).toEqual(['t1:pending']);
    expect(await outbox(phone.client, other)).toEqual([]);
    // No MLS resync pause for a general 429.
    expect(phone.client.resyncPausedUntil(throttled)).toBeUndefined();

    // A later flush delivers it, exactly once.
    phone.transport.sendMessage = sendMessage;
    const before = await serverCount(throttled);
    expect(await phone.client.flushOutbox()).toBe(1);
    expect(await phone.client.flushOutbox()).toBe(0);
    expect(await serverCount(throttled)).toBe(before + 1);

    // Permanent errors still fail the message (and the flush continues past it).
    phone.transport.sendMessage = offline;
    await phone.client.send(throttled, { text: 'bad' }).catch(() => undefined);
    await phone.client.send(other, { text: 'good' }).catch(() => undefined);
    phone.transport.sendMessage = (conversationId, body) =>
      conversationId === throttled
        ? Promise.reject(new TransportError('Forbidden', 403, 'FORBIDDEN'))
        : sendMessage(conversationId, body);
    expect(await phone.client.flushOutbox()).toBe(1);
    expect(await outbox(phone.client, throttled)).toEqual(['bad:failed']);
    expect(await outbox(phone.client, other)).toEqual([]);
    phone.transport.sendMessage = sendMessage;
  }, 120_000);
});
