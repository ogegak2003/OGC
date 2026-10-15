import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentsService } from '../src/modules/attachments/attachments.service.js';
import { PushProvider, type PushNotification } from '../src/modules/notifications/push-provider.js';
import { connectSocket, eventually, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

// Small, configurable limits for this file (read when the app module is created).
process.env.RATE_LIMIT_MESSAGE_SEND = '4';
process.env.RATE_LIMIT_TYPING = '2';
process.env.RATE_LIMIT_SOCKET_CONNECT = '6';
process.env.METRICS_TOKEN = 'metrics-token-for-tests-0123456789abcdef';

class CapturingPushProvider extends PushProvider {
  readonly name = 'capture';
  readonly sent: PushNotification[] = [];
  send(notifications: PushNotification[]): Promise<undefined> {
    this.sent.push(...notifications);
    return Promise.resolve(undefined);
  }
}

describe('messaging operations', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  const push = new CapturingPushProvider();

  beforeAll(async () => {
    t = await createTestApp({ overrides: [{ provide: PushProvider, useValue: push }] });
    baseUrl = await listen(t);
    [alice, bob] = await Promise.all([signedInUser(t, 'Alice'), signedInUser(t, 'Bob')]);
    await makeContacts(t, alice, bob);
  });

  afterAll(async () => {
    await t.close();
  });

  it('enforces the configured per-account send limit', async () => {
    const aliceDevice = await newDevice(t, baseUrl, alice);
    await newDevice(t, baseUrl, bob);
    const conversation = await aliceDevice.client.openDirect(bob.ogcId);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        await aliceDevice.client.send(conversation.id, { text: `burst ${i}` });
        statuses.push(201);
      } catch (error) {
        statuses.push((error as { status: number }).status);
      }
    }
    expect(statuses).toEqual([201, 201, 201, 201, 429]);
    // A rate-limited message stays queued on the device for a later retry.
    expect((await aliceDevice.client.messages(conversation.id)).at(-1)?.state).toBe('pending');
  });

  it('rate-limits typing events and socket connections', async () => {
    const aliceDevice = await newDevice(t, baseUrl, alice, false);
    const bobDevice = await newDevice(t, baseUrl, bob, false);
    const conversation = await request(t.server)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${aliceDevice.token}`)
      .send({ ogcId: bob.ogcId });
    const id = (conversation.body as { id: string }).id;
    const aliceLive = connectSocket(baseUrl, { token: aliceDevice.token });
    const bobLive = connectSocket(baseUrl, { token: bobDevice.token });
    await Promise.all([aliceLive.connected, bobLive.connected]);
    for (let i = 0; i < 5; i++) aliceLive.socket.emit('typing.start', { conversationId: id });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(bobLive.events.filter((e) => e.event === 'message.typing')).toHaveLength(2);

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, async () => {
        const c = connectSocket(baseUrl, { token: aliceDevice.token });
        try {
          await c.connected;
        } finally {
          c.socket.disconnect();
        }
      }),
    );
    expect(attempts.some((a) => a.status === 'rejected')).toBe(true);
    aliceLive.socket.disconnect();
    bobLive.socket.disconnect();
  });

  it('pushes a generic notification to offline devices only, never message content', async () => {
    const carol = await signedInUser(t, 'Carol');
    const dave = await signedInUser(t, 'Dave');
    await makeContacts(t, carol, dave);
    const carolDevice = await newDevice(t, baseUrl, carol);
    const daveOffline = await newDevice(t, baseUrl, dave);
    const daveOnline = await newDevice(t, baseUrl, dave);
    for (const [device, token] of [
      [daveOffline, 'ExponentPushToken[offline-device]'],
      [daveOnline, 'ExponentPushToken[online-device]'],
    ] as const) {
      await request(t.server)
        .put('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${device.token}`)
        .send({ provider: 'EXPO', token })
        .expect(204);
    }
    const live = connectSocket(baseUrl, { token: daveOnline.token });
    await live.connected;

    const conversation = await carolDevice.client.openDirect(dave.ogcId);
    await carolDevice.client.send(conversation.id, { text: 'Top secret launch date' });
    const notifications = await eventually(
      () =>
        push.sent.filter(
          (n) => n.data.type === 'message' && n.data.conversationId === conversation.id,
        ),
      (list) => list.length > 0,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      provider: 'EXPO',
      token: 'ExponentPushToken[offline-device]',
      title: 'OGC',
      body: 'New message',
      data: { type: 'message', conversationId: conversation.id },
    });
    expect(JSON.stringify(push.sent)).not.toContain('secret');
    live.socket.disconnect();
  });

  it('binds push tokens to the registering device and removes them on logout', async () => {
    const one = await newDevice(t, baseUrl, alice, false);
    const two = await newDevice(t, baseUrl, bob, false);
    const register = (token: string, value: string) =>
      request(t.server)
        .put('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'EXPO', token: value });
    await register(one.token, 'ExponentPushToken[shared]').expect(204);
    // The same token registered by another device moves there (e.g. a reinstalled app).
    await register(two.token, 'ExponentPushToken[shared]').expect(204);
    expect(await t.prisma.pushToken.count({ where: { token: 'ExponentPushToken[shared]' } })).toBe(
      1,
    );
    await register(one.token, 'not a token').expect(400);
    await request(t.server)
      .put('/api/v1/notifications/push-token')
      .set('Authorization', `Bearer ${one.token}`)
      .send({ provider: 'EXPO', token: 'ExponentPushToken[x]', deviceId: randomUUID() })
      .expect(400);
    await request(t.server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${two.token}`)
      .expect(204);
    await eventually(
      () => t.prisma.pushToken.count({ where: { token: 'ExponentPushToken[shared]' } }),
      (n) => n === 0,
    );
  });

  it('rejects expired sessions on REST and realtime', async () => {
    const device = await newDevice(t, baseUrl, alice, false);
    const session = await t.prisma.session.findFirstOrThrow({
      where: { userId: alice.userId },
      orderBy: { createdAt: 'desc' },
    });
    await t.prisma.session.update({
      where: { id: session.id },
      data: { accessExpiresAt: new Date(Date.now() - 1_000) },
    });
    await request(t.server)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${device.token}`)
      .expect(401);
    await expect(connectSocket(baseUrl, { token: device.token }).connected).rejects.toThrow(
      'unauthorized',
    );
  });

  it('exposes metrics only with the metrics token, without identifiers or content', async () => {
    await request(t.server).get('/api/v1/metrics').expect(401);
    await request(t.server).get('/api/v1/metrics').set('Authorization', 'Bearer wrong').expect(401);
    const res = await request(t.server)
      .get('/api/v1/metrics')
      .set('Authorization', `Bearer ${process.env.METRICS_TOKEN ?? ''}`)
      .expect(200);
    expect(res.text).toContain('ogc_messages_sent_total');
    expect(res.text).toContain('ogc_realtime_connections');
    expect(res.text).toContain('ogc_rate_limited_total');
    expect(res.text).not.toContain(alice.ogcId);
    expect(res.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('deletes uploaded attachments that never became part of a message', async () => {
    const aliceDevice = await newDevice(t, baseUrl, alice, false);
    const conversation = await aliceDevice.transport.openConversation(bob.ogcId);
    const upload = await aliceDevice.transport.uploadAttachment(
      conversation.id,
      'FILE',
      new Uint8Array(64).fill(7),
    );
    const service = t.app.get(AttachmentsService);
    expect(await service.purgeOrphans(new Date())).toBe(0);
    const removed = await service.purgeOrphans(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await t.prisma.attachment.count({ where: { id: upload.id } })).toBe(0);
    await expect(aliceDevice.transport.downloadAttachment(upload.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
