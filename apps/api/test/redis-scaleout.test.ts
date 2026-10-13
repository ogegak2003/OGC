import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisThrottlerStorage } from '../src/common/throttling/redis-throttler.storage.js';
import { RedisPresence } from '../src/modules/realtime/presence.store.js';
import { connectSocket, eventually, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/**
 * Horizontal scaling: two API instances sharing PostgreSQL and Redis must
 * behave as one — realtime events cross instances, rate limits are shared,
 * presence is global. Requires TEST_REDIS_URL (CI provides a Redis service).
 */
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('TEST_REDIS_URL is required for the Redis integration tests');
process.env.REDIS_URL = redisUrl;
process.env.RATE_LIMIT_MESSAGE_SEND = '3';

describe('two API instances sharing Redis', () => {
  let a: TestApp;
  let b: TestApp;
  let urlA: string;
  let urlB: string;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    a = await createTestApp();
    b = await createTestApp();
    [urlA, urlB] = [await listen(a), await listen(b)];
    [alice, bob] = await Promise.all([signedInUser(a, 'Alice'), signedInUser(a, 'Bob')]);
    await makeContacts(a, alice, bob);
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('delivers realtime events to sockets connected to the other instance', async () => {
    const aliceDevice = await newDevice(a, urlA, alice);
    const bobDevice = await newDevice(b, urlB, bob);
    const bobLive = connectSocket(urlB, { token: bobDevice.token });
    await bobLive.connected;
    const conversation = await aliceDevice.client.openDirect(bob.ogcId);
    await aliceDevice.client.send(conversation.id, { text: 'across instances' });
    await eventually(
      () => bobLive.events.filter((e) => e.event === 'message.created'),
      (l) => l.length > 0,
    );
    bobLive.socket.disconnect();
  });

  it('shares presence between instances', async () => {
    const aliceDevice = await newDevice(a, urlA, alice, false);
    const bobDevice = await newDevice(b, urlB, bob, false);
    const aliceLive = connectSocket(urlA, { token: aliceDevice.token });
    const bobLive = connectSocket(urlB, { token: bobDevice.token });
    await Promise.all([aliceLive.connected, bobLive.connected]);
    const ack = await new Promise<{ ok: boolean; data?: { state: string }[] }>((resolve) => {
      bobLive.socket.emit('presence.subscribe', { ogcIds: [alice.ogcId as never] }, resolve);
    });
    expect(ack.data?.[0]?.state).toBe('ONLINE');
    aliceLive.socket.disconnect();
    await eventually(
      () => bobLive.events.filter((e) => e.event === 'presence.updated'),
      (l) => l.some((e) => (e.payload as { state: string }).state === 'OFFLINE'),
    );
    bobLive.socket.disconnect();
  });

  it('enforces one rate limit across instances', async () => {
    const carol = await signedInUser(a, 'Carol');
    await makeContacts(a, carol, bob);
    const viaA = await newDevice(a, urlA, carol);
    const viaB = await newDevice(b, urlB, carol);
    await newDevice(a, urlA, bob);
    const conversation = await viaA.client.openDirect(bob.ogcId);
    await viaA.client.send(conversation.id, { text: '1' });
    await viaA.client.send(conversation.id, { text: '2' });
    await viaB.client.syncConversation(conversation.id);
    await viaB.client.send(conversation.id, { text: '3' });
    await expect(viaB.client.send(conversation.id, { text: '4' })).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('Redis stores', () => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const prefix = `ogc:test:${randomUUID()}:`;

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('counts hits in a fixed window and blocks once over the limit', async () => {
    const storage = new RedisThrottlerStorage(redis, prefix);
    const key = randomUUID();
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await storage.increment(key, 60_000, 3, 5_000, 'default'));
    expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
    expect(results[3]?.timeToBlockExpire).toBe(5);
    expect(results[0]?.timeToExpire).toBeLessThanOrEqual(60);
    // Separate keys and throttler names do not interfere.
    expect((await storage.increment(randomUUID(), 60_000, 3, 0, 'default')).totalHits).toBe(1);
    expect((await storage.increment(key, 60_000, 3, 0, 'other')).totalHits).toBe(1);
  });

  it('tracks presence per account and device with expiring connections', async () => {
    const presence = new RedisPresence(redis);
    const userId = `${prefix}${randomUUID()}`;
    const deviceA = `${prefix}${randomUUID()}`;
    const deviceB = `${prefix}${randomUUID()}`;
    expect(await presence.connect({ userId, deviceId: deviceA, socketId: 's1' })).toBe(true);
    expect(await presence.connect({ userId, deviceId: deviceB, socketId: 's2' })).toBe(false);
    expect(await presence.onlineUsers([userId, 'nobody'])).toEqual(new Set([userId]));
    expect(await presence.onlineDevices([deviceA, deviceB])).toEqual(new Set([deviceA, deviceB]));
    expect(await presence.disconnect({ userId, deviceId: deviceA, socketId: 's1' })).toBe(false);
    expect(await presence.onlineDevices([deviceA, deviceB])).toEqual(new Set([deviceB]));
    expect(await presence.disconnect({ userId, deviceId: deviceB, socketId: 's2' })).toBe(true);
    expect(await presence.onlineUsers([userId])).toEqual(new Set());

    // A crashed instance never sends disconnect: its entries expire on their own.
    await redis.zadd(`ogc:presence:u:${userId}`, Date.now() - 1, 'ghost');
    expect(await presence.onlineUsers([userId])).toEqual(new Set());
    await redis.del(
      `ogc:presence:u:${userId}`,
      `ogc:presence:d:${deviceA}`,
      `ogc:presence:d:${deviceB}`,
    );
  });
});
