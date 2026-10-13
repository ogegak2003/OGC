import type { ConversationView, NotificationPage, ReceivedInvitationView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/modules/groups/invitations.service.js';
import { CommunityNotificationsService } from '../src/modules/notifications/community-notifications.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { type PushNotification, PushProvider } from '../src/modules/notifications/push-provider.js';
import { connectSocket, eventually, listen } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  nativeTokens,
  signedInUser,
} from './support/test-app.js';

class CapturingPushProvider extends PushProvider {
  readonly name = 'capture';
  readonly sent: PushNotification[] = [];
  send(notifications: PushNotification[]): Promise<void> {
    this.sent.push(...notifications);
    return Promise.resolve();
  }
}

/** In-app community notifications, realtime delivery, generic push and preferences. */
describe('community notifications', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let groupId: string;
  const push = new CapturingPushProvider();
  const api = () => request(t.server);

  beforeAll(async () => {
    t = await createTestApp({ overrides: [{ provide: PushProvider, useValue: push }] });
    baseUrl = await listen(t);
    [alice, bob] = await Promise.all([signedInUser(t, 'Alice'), signedInUser(t, 'Bob')]);
    await makeContacts(t, alice, bob);
    // Bob has an offline device with a push token.
    const offline = await nativeTokens(t, bob.email);
    await api()
      .put('/api/v1/notifications/push-token')
      .set('Authorization', `Bearer ${offline.accessToken}`)
      .send({ provider: 'EXPO', token: 'ExponentPushToken[bob-offline]' })
      .expect(204);
    const res = await alice
      .as(api().post('/api/v1/groups'))
      .send({ name: 'Secret Santa 2026' })
      .expect(201);
    groupId = (res.body as { conversation: ConversationView }).conversation.id;
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('delivers an invitation in realtime, in the inbox and as a generic push', async () => {
    const live = connectSocket(baseUrl, { token: bob.accessToken });
    await live.connected;
    await alice
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [bob.ogcId] })
      .expect(201);
    await eventually(
      () => live.events.map((e) => e.event),
      (events) =>
        events.includes('community.notification') && events.includes('group.invitation_created'),
    );
    const inbox = await bob.as(api().get('/api/v1/notifications')).expect(200);
    const page = inbox.body as NotificationPage;
    expect(page.unread).toBe(1);
    expect(page.items[0]).toMatchObject({
      type: 'GROUP_INVITATION',
      data: { groupName: 'Secret Santa 2026', inviter: alice.ogcId },
      readAt: null,
    });
    const pushes = await eventually(
      () => push.sent.filter((n) => n.token === 'ExponentPushToken[bob-offline]'),
      (list) => list.length > 0,
    );
    // Push text is fixed and generic: no group name, no inviter.
    expect(pushes[0]).toMatchObject({
      title: 'OGC',
      body: 'You have a new group invitation',
      data: { type: 'community', notification: 'GROUP_INVITATION' },
    });
    expect(JSON.stringify(push.sent)).not.toContain('Secret Santa');
    live.socket.disconnect();

    await bob.as(api().post('/api/v1/notifications/read')).send({ all: true }).expect(204);
    const after = await bob.as(api().get('/api/v1/notifications')).expect(200);
    expect((after.body as NotificationPage).unread).toBe(0);
    // Nobody can read someone else's notifications by ID.
    await alice
      .as(api().post('/api/v1/notifications/read'))
      .send({ ids: [page.items[0]?.id ?? ''] })
      .expect(204);
    const aliceInbox = await alice.as(api().get('/api/v1/notifications')).expect(200);
    expect(JSON.stringify(aliceInbox.body)).not.toContain(page.items[0]?.id ?? 'x');
  });

  it('never notifies twice for the same event (retries, several devices)', async () => {
    const service = t.app.get(CommunityNotificationsService);
    const before = await t.prisma.notification.count({ where: { userId: bob.userId } });
    const input = {
      userId: bob.userId,
      type: 'GROUP_DETAILS_CHANGED' as const,
      dedupeKey: `test:${crypto.randomUUID()}`,
      data: { conversationId: groupId },
    };
    await Promise.all([service.notify([input]), service.notify([input]), service.notify([input])]);
    expect(await t.prisma.notification.count({ where: { userId: bob.userId } })).toBe(before + 1);
  });

  it('honours notification levels and mutes for message pushes', async () => {
    const list = await bob.as(api().get('/api/v1/invitations')).expect(200);
    const invitation = (list.body as ReceivedInvitationView[])[0];
    await bob.as(api().post(`/api/v1/invitations/${invitation?.id ?? ''}/accept`)).expect(200);
    const service = t.app.get(NotificationsService);

    await bob
      .as(api().put(`/api/v1/conversations/${groupId}/notifications`))
      .send({ level: 'MENTIONS' })
      .expect(200);
    expect(await service.notifyNewMessage(groupId, [bob.userId], [])).toBe(0);
    expect(await service.notifyNewMessage(groupId, [bob.userId], [bob.userId])).toBe(1);

    await bob
      .as(api().put(`/api/v1/conversations/${groupId}/notifications`))
      .send({ level: 'ALL', mutedUntil: new Date(Date.now() + 60_000).toISOString() })
      .expect(200);
    expect(await service.notifyNewMessage(groupId, [bob.userId], [bob.userId])).toBe(0);
    await bob
      .as(api().put(`/api/v1/conversations/${groupId}/notifications`))
      .send({ mutedUntil: null })
      .expect(200);
    expect(await service.notifyNewMessage(groupId, [bob.userId], [])).toBe(1);
  });

  it('expires stale invitations and tells the inviter once', async () => {
    const carol = await signedInUser(t, 'Carol');
    await makeContacts(t, alice, carol);
    await alice
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [carol.ogcId] })
      .expect(201);
    await t.prisma.conversationInvitation.updateMany({
      where: { inviteeId: carol.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const invitations = t.app.get(InvitationsService);
    // Other test files share the database, so only this invitation's outcome is asserted.
    expect(await invitations.expire()).toBeGreaterThanOrEqual(1);
    await invitations.expire();
    const notices = await t.prisma.notification.findMany({
      where: { userId: alice.userId, type: 'INVITATION_EXPIRED' },
    });
    expect(notices).toHaveLength(1);
    const row = await t.prisma.conversationInvitation.findFirstOrThrow({
      where: { inviteeId: carol.userId },
    });
    expect(row.status).toBe('EXPIRED');
  });
});
