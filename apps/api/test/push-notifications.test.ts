import type { ConversationView, NotificationSettingsView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import {
  type PushNotification,
  PushProvider,
  type PushReceipt,
  type PushResult,
} from '../src/modules/notifications/push-provider.js';
import { type TestDevice, eventually, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  clientIp,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/**
 * A scriptable provider standing in for Expo (MOCKED — these tests never reach a real push
 * service or device). Results can be scripted per token, in order; receipts by ticket.
 */
class ScriptedProvider extends PushProvider {
  readonly name = 'scripted';
  readonly sent: PushNotification[] = [];
  readonly script = new Map<string, PushResult[]>();
  readonly receiptsByTicket = new Map<string, PushReceipt>();
  send(notifications: PushNotification[]): Promise<PushResult[]> {
    this.sent.push(...notifications);
    return Promise.resolve(
      notifications.map(
        (n) => this.script.get(n.token)?.shift() ?? { ok: true, ticketId: `t-${n.token}` },
      ),
    );
  }
  override receipts(ids: string[]): Promise<Map<string, PushReceipt>> {
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const receipt = this.receiptsByTicket.get(id);
          return receipt ? [[id, receipt] as const] : [];
        }),
      ),
    );
  }
}

describe('push notifications', () => {
  let t: TestApp;
  let baseUrl: string;
  const provider = new ScriptedProvider();
  const saved = { ...process.env };
  let alice: TestUser;
  let bob: TestUser;
  let aliceDevice: TestDevice;
  let conversation: ConversationView;
  let tokenCounter = 0;

  const api = () => request(t.server);
  const forTo = (token: string) => provider.sent.filter((n) => n.token === token);

  /** A new signed-in device for `user`, with a push token, and no live connection. */
  async function offlineDevice(
    user: TestUser,
  ): Promise<{ device: TestDevice; token: string; deviceId: string }> {
    const device = await newDevice(t, baseUrl, user, false);
    tokenCounter += 1;
    const token = `ExponentPushToken[test-${String(tokenCounter)}]`;
    await api()
      .put('/api/v1/notifications/push-token')
      .set('Authorization', `Bearer ${device.token}`)
      .set('X-Forwarded-For', clientIp())
      .send({ provider: 'EXPO', token })
      .expect(204);
    const { deviceId } = await t.prisma.pushToken.findFirstOrThrow({ where: { token } });
    return { device, token, deviceId };
  }

  async function settings(user: TestUser, body: object): Promise<NotificationSettingsView> {
    const res = await user.as(api().put('/api/v1/notifications/settings')).send(body).expect(200);
    return res.body as NotificationSettingsView;
  }

  beforeAll(async () => {
    process.env.PUSH_WORKER_INTERVAL_MS = '100';
    process.env.PUSH_RETRY_BASE_MS = '50';
    process.env.PUSH_MAX_ATTEMPTS = '3';
    process.env.PUSH_RECEIPT_DELAY_SECONDS = '0';
    process.env.RATE_LIMIT_PUSH_REGISTER = '30';
    t = await createTestApp({ overrides: [{ provide: PushProvider, useValue: provider }] });
    baseUrl = await listen(t);
    [alice, bob] = await Promise.all([signedInUser(t, 'Alice'), signedInUser(t, 'Bob')]);
    await makeContacts(t, alice, bob);
    aliceDevice = await newDevice(t, baseUrl, alice);
    // Bob's main device (keys published, so messages to him are encrypted for real).
    await newDevice(t, baseUrl, bob);
    conversation = await aliceDevice.client.openDirect(bob.ogcId);
  });

  beforeEach(async () => {
    provider.sent.length = 0;
    provider.script.clear();
    // Each test starts from default settings for both people.
    await t.prisma.notificationSettings.deleteMany({
      where: { userId: { in: [alice.userId, bob.userId] } },
    });
  });

  afterAll(async () => {
    await t.close();
    process.env = saved;
  });

  describe('settings', () => {
    it('starts private by default and saves partial, validated updates', async () => {
      const initial = await bob.as(api().get('/api/v1/notifications/settings')).expect(200);
      expect(initial.body).toMatchObject({ enabled: true, preview: 'GENERIC', messages: true });
      const updated = await settings(bob, {
        messages: false,
        quietHours: { enabled: true, start: 1320, end: 420, timeZone: 'Africa/Nairobi' },
      });
      expect(updated).toMatchObject({
        messages: false,
        groups: true,
        quietHours: { enabled: true, start: 1320, end: 420, timeZone: 'Africa/Nairobi' },
      });
      // A later partial update keeps the rest.
      expect(await settings(bob, { preview: 'SENDER' })).toMatchObject({
        messages: false,
        preview: 'SENDER',
      });
      // Alice's settings are untouched: there is no way to address someone else's.
      const hers = await alice.as(api().get('/api/v1/notifications/settings')).expect(200);
      expect(hers.body).toMatchObject({ messages: true, preview: 'GENERIC' });
    });

    it('rejects invalid settings and anonymous requests', async () => {
      for (const body of [
        {},
        { userId: alice.userId, messages: false },
        { preview: 'FULL' },
        { quietHours: { enabled: true, start: 60, end: 60, timeZone: 'UTC' } },
        { quietHours: { enabled: true, start: 60, end: 120, timeZone: 'Nowhere/City' } },
      ]) {
        await bob.as(api().put('/api/v1/notifications/settings')).send(body).expect(400);
      }
      await api().get('/api/v1/notifications/settings').expect(401);
      await api().put('/api/v1/notifications/settings').send({ messages: false }).expect(401);
    });
  });

  describe('message pushes', () => {
    it('alerts the recipient, never the sender, with no message content', async () => {
      const bobOffline = await offlineDevice(bob);
      const aliceOffline = await offlineDevice(alice);
      await aliceDevice.client.send(conversation.id, { text: 'The vault code is 4421' });
      const [push] = await eventually(
        () => forTo(bobOffline.token),
        (list) => list.length > 0,
      );
      expect(push).toMatchObject({
        title: 'OGC',
        body: 'New message',
        data: { type: 'message', conversationId: conversation.id },
        sound: true,
        vibration: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(forTo(aliceOffline.token)).toEqual([]);
      expect(JSON.stringify(provider.sent)).not.toContain('4421');
      expect(JSON.stringify(provider.sent)).not.toContain('vault');
    });

    it('shows the sender’s name only when the recipient chose sender previews', async () => {
      const bobOffline = await offlineDevice(bob);
      await settings(bob, { preview: 'SENDER' });
      await aliceDevice.client.send(conversation.id, { text: 'hello' });
      const [push] = await eventually(
        () => forTo(bobOffline.token),
        (list) => list.length > 0,
      );
      expect(push).toMatchObject({ title: 'Alice', body: 'New message' });
      expect(JSON.stringify(push)).not.toContain('hello');
    });

    it('respects the master switch, the category switch and a muted conversation', async () => {
      const bobOffline = await offlineDevice(bob);
      await settings(bob, { enabled: false });
      await aliceDevice.client.send(conversation.id, { text: 'one' });
      await settings(bob, { enabled: true, messages: false });
      await aliceDevice.client.send(conversation.id, { text: 'two' });
      await settings(bob, { messages: true });
      await bob
        .as(api().put(`/api/v1/conversations/${conversation.id}/notifications`))
        .send({ mutedUntil: new Date(Date.now() + 3600_000).toISOString() })
        .expect(200);
      await aliceDevice.client.send(conversation.id, { text: 'three' });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(forTo(bobOffline.token)).toEqual([]);
      expect(await t.prisma.pushDelivery.count({ where: { deviceId: bobOffline.deviceId } })).toBe(
        0,
      );
      await bob
        .as(api().put(`/api/v1/conversations/${conversation.id}/notifications`))
        .send({ mutedUntil: null })
        .expect(200);
    });

    it('delivers silently during quiet hours', async () => {
      const bobOffline = await offlineDevice(bob);
      // A window covering every minute but one: the current time is inside it.
      const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      await settings(bob, {
        quietHours: {
          enabled: true,
          start: (minute + 1438) % 1440,
          end: (minute + 2) % 1440,
          timeZone: 'UTC',
        },
      });
      await aliceDevice.client.send(conversation.id, { text: 'late' });
      const [push] = await eventually(
        () => forTo(bobOffline.token),
        (list) => list.length > 0,
      );
      expect(push).toMatchObject({ sound: false, vibration: false, body: 'New message' });
    });

    it('sends nothing to someone who blocked the sender, or whose account is suspended', async () => {
      const carol = await signedInUser(t, 'Carol');
      await makeContacts(t, alice, carol);
      const carolOffline = await offlineDevice(carol);
      const toCarol = await aliceDevice.client.openDirect(carol.ogcId);
      const blocked = await carol.as(api().post(`/api/v1/blocks/${alice.ogcId}`));
      expect(blocked.status).toBeLessThan(300);
      await aliceDevice.client.send(toCarol.id, { text: 'are you there' });
      await carol.as(api().delete(`/api/v1/blocks/${alice.ogcId}`));
      await t.prisma.user.update({ where: { id: carol.userId }, data: { status: 'SUSPENDED' } });
      await aliceDevice.client.send(toCarol.id, { text: 'hello?' }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(forTo(carolOffline.token)).toEqual([]);
    });
  });

  describe('delivery queue', () => {
    it('retries temporary provider errors with backoff, then succeeds', async () => {
      const bobOffline = await offlineDevice(bob);
      provider.script.set(bobOffline.token, [
        { ok: false, code: 'HTTP_503', retryable: true, invalidToken: false },
        { ok: false, code: 'NETWORK', retryable: true, invalidToken: false },
      ]);
      await aliceDevice.client.send(conversation.id, { text: 'retry me' });
      const row = await eventually(
        () =>
          t.prisma.pushDelivery.findFirst({
            where: { deviceId: bobOffline.deviceId, status: { in: ['SENT', 'DELIVERED'] } },
            orderBy: { createdAt: 'desc' },
          }),
        Boolean,
      );
      expect(row?.attempts).toBe(3);
      expect(forTo(bobOffline.token)).toHaveLength(3);
    });

    it('gives up after the attempt limit, and on permanent errors at once', async () => {
      const flaky = await offlineDevice(bob);
      const broken = await offlineDevice(bob);
      provider.script.set(
        flaky.token,
        Array.from({ length: 5 }, () => ({
          ok: false as const,
          code: 'HTTP_503',
          retryable: true,
          invalidToken: false,
        })),
      );
      provider.script.set(broken.token, [
        { ok: false, code: 'MessageTooBig', retryable: false, invalidToken: false },
      ]);
      await aliceDevice.client.send(conversation.id, { text: 'x' });
      await eventually(
        () => forTo(flaky.token).length,
        (n) => n === 3,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(forTo(flaky.token)).toHaveLength(3); // PUSH_MAX_ATTEMPTS
      expect(forTo(broken.token)).toHaveLength(1);
      const failed = await t.prisma.pushDelivery.findMany({
        where: {
          userId: bob.userId,
          status: 'FAILED',
          lastError: { in: ['HTTP_503', 'MessageTooBig'] },
        },
      });
      expect(failed.map((f) => f.lastError).sort()).toEqual(['HTTP_503', 'MessageTooBig']);
    });

    it('removes a token the provider says is dead', async () => {
      const gone = await offlineDevice(bob);
      provider.script.set(gone.token, [
        { ok: false, code: 'DeviceNotRegistered', retryable: false, invalidToken: true },
      ]);
      await aliceDevice.client.send(conversation.id, { text: 'y' });
      await eventually(
        () => t.prisma.pushToken.count({ where: { token: gone.token } }),
        (n) => n === 0,
      );
    });

    it('checks delivery receipts and drops tokens that died later', async () => {
      const later = await offlineDevice(bob);
      provider.receiptsByTicket.set(`t-${later.token}`, {
        ok: false,
        code: 'DeviceNotRegistered',
        invalidToken: true,
      });
      await aliceDevice.client.send(conversation.id, { text: 'z' });
      await eventually(
        () => t.prisma.pushToken.count({ where: { token: later.token } }),
        (n) => n === 0,
        40_000,
      );
    });

    it('never queues the same event twice for a device (idempotent)', async () => {
      const bobOffline = await offlineDevice(bob);
      const service = t.app.get(NotificationsService);
      const messageId = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f';
      await service.notifyNewMessage(conversation.id, [bob.userId], [], messageId, alice.userId);
      await service.notifyNewMessage(conversation.id, [bob.userId], [], messageId, alice.userId);
      await eventually(
        () => forTo(bobOffline.token),
        (list) => list.length > 0,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(forTo(bobOffline.token)).toHaveLength(1);
    });

    it('expires pushes that were not sent in time, and fails pushes for signed-out devices', async () => {
      const late = await offlineDevice(bob);
      const row = await t.prisma.pushDelivery.create({
        data: {
          userId: bob.userId,
          deviceId: late.deviceId,
          category: 'CALL',
          dedupeKey: 'call:expired-test:incoming',
          title: 'OGC',
          body: 'Incoming call',
          data: { type: 'call', callId: 'x', conversationId: conversation.id },
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      await eventually(
        () => t.prisma.pushDelivery.findUniqueOrThrow({ where: { id: row.id } }),
        (r) => r.status === 'EXPIRED',
      );
      expect(forTo(late.token)).toEqual([]);

      const signedOut = await offlineDevice(bob);
      await api()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${signedOut.device.token}`)
        .set('X-Forwarded-For', clientIp())
        .expect(204);
      // Session revocation removes the device's token (asynchronously, with its keys).
      await eventually(
        () => t.prisma.pushToken.count({ where: { token: signedOut.token } }),
        (n) => n === 0,
      );
    });
  });

  describe('contact requests', () => {
    it('alerts the recipient only', async () => {
      const dave = await signedInUser(t, 'Dave');
      const daveOffline = await offlineDevice(dave);
      const aliceOffline = await offlineDevice(alice);
      await alice
        .as(api().post('/api/v1/contacts/requests'))
        .send({ ogcId: dave.ogcId })
        .expect(201);
      const [push] = await eventually(
        () => forTo(daveOffline.token),
        (list) => list.length > 0,
      );
      expect(push).toMatchObject({
        title: 'OGC',
        body: 'New contact request',
        data: { type: 'contact', event: 'request' },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(forTo(aliceOffline.token)).toEqual([]);
    });
  });

  describe('push-token ownership', () => {
    const put = (device: TestDevice, body: object) =>
      api()
        .put('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${device.token}`)
        .set('X-Forwarded-For', clientIp())
        .send(body);

    it('binds a token to the registering device; the client cannot choose another', async () => {
      const mine = await offlineDevice(bob);
      const other = await offlineDevice(bob);
      // Naming a device (or account) in the body is refused outright.
      await put(mine.device, {
        provider: 'EXPO',
        token: 'ExponentPushToken[forged-owner]',
        deviceId: other.deviceId,
      }).expect(400);
      await put(mine.device, {
        provider: 'EXPO',
        token: 'ExponentPushToken[forged-owner]',
        userId: alice.userId,
      }).expect(400);
      expect(
        await t.prisma.pushToken.count({ where: { token: 'ExponentPushToken[forged-owner]' } }),
      ).toBe(0);
      // Unregistering removes this device's token only.
      await api()
        .delete('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${mine.device.token}`)
        .set('X-Forwarded-For', clientIp())
        .expect(204);
      expect(
        await t.prisma.pushToken.findUnique({ where: { deviceId: mine.deviceId } }),
      ).toBeNull();
      expect(
        (await t.prisma.pushToken.findUnique({ where: { deviceId: other.deviceId } }))?.token,
      ).toBe(other.token);
      await api()
        .put('/api/v1/notifications/push-token')
        .send({ provider: 'EXPO', token: 'ExponentPushToken[anon]' })
        .expect(401);
    });

    it('never serves one token to two accounts: re-registering moves it', async () => {
      // A phone reinstalled into another account: the token moves, so Bob's alerts stop going
      // there; only Carol's account can now be notified on it.
      const bobPhone = await offlineDevice(bob);
      const carol = await signedInUser(t, 'Carol');
      const carolDevice = await newDevice(t, baseUrl, carol, false);
      await put(carolDevice, { provider: 'EXPO', token: bobPhone.token }).expect(204);
      const holders = await t.prisma.pushToken.findMany({ where: { token: bobPhone.token } });
      expect(holders).toHaveLength(1);
      expect(holders[0]?.deviceId).not.toBe(bobPhone.deviceId);

      await aliceDevice.client.send(conversation.id, { text: 'for Bob only' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Bob's message alert never reaches the device now registered to Carol's account.
      expect(forTo(bobPhone.token)).toEqual([]);
    });
  });

  it('rate-limits push-token registration', async () => {
    const erin = await signedInUser(t, 'Erin');
    const device = await newDevice(t, baseUrl, erin, false);
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      const res = await api()
        .put('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${device.token}`)
        .set('X-Forwarded-For', clientIp())
        .send({ provider: 'EXPO', token: `ExponentPushToken[rl-${String(i)}]` });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });
});
