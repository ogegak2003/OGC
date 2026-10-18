import { MessagingClient, type MessagingEvent, pendingGroupWarnings } from '@ogc/messaging';
import type { ConversationView, OgcId } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDevice, eventually, listen, newDevice } from './support/messaging.js';
import { type TestApp, type TestUser, createTestApp, signedInUser } from './support/test-app.js';

/**
 * A device that is its group's only member and loses its group state cannot resync (ts-mls
 * cannot remove a tree's last leaf). The engine then waits — messages stay pending, no requests
 * are made — until a membership event shows another device, and then recovers through the
 * normal verified resync.
 */
describe('sole-member recovery waiting state', () => {
  let t: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
  });

  afterAll(async () => {
    await t.close();
  });

  async function soloGroup(user: TestUser, device: TestDevice, name: string): Promise<string> {
    const created = await user
      .as(request(t.server).post('/api/v1/groups'))
      .send({ name })
      .expect(201);
    const id = (created.body as { conversation: ConversationView }).conversation.id;
    await device.client.refreshConversations();
    await device.client.send(id, { text: `${name} created` });
    return id;
  }

  /** Counts this device's MLS group lookups and commit submissions, per conversation. */
  function countRequests(device: TestDevice) {
    const lookups = new Map<string, number>();
    const commits = new Map<string, number>();
    const { mlsGroup, submitCommit } = device.transport;
    device.transport.mlsGroup = (id) => {
      lookups.set(id, (lookups.get(id) ?? 0) + 1);
      return mlsGroup(id);
    };
    device.transport.submitCommit = (id, body) => {
      commits.set(id, (commits.get(id) ?? 0) + 1);
      return submitCommit(id, body);
    };
    return {
      lookups: (id: string) => lookups.get(id) ?? 0,
      commits: (id: string) => commits.get(id) ?? 0,
    };
  }

  const pendingTexts = async (client: MessagingClient, id: string) =>
    (await client.messages(id)).filter((m) => m.state === 'pending').map((m) => m.payload?.text);

  it('waits without requests, ignores unrelated events, and recovers once another device joins', async () => {
    const user = await signedInUser(t, 'Solo');
    const phone = await newDevice(t, baseUrl, user);
    const id = await soloGroup(user, phone, 'Alone');
    const other = await soloGroup(user, phone, 'Other');
    const events: MessagingEvent[] = [];
    phone.client.subscribe((e) => events.push(e));
    const counts = countRequests(phone);

    // The phone loses its group state while it is the group's only member.
    await phone.store.delete(`group:${id}`);
    const queued = await phone.client.send(id, { text: 'queued 1' });
    expect(queued.state).toBe('pending');
    expect(phone.client.awaitingAnotherDevice(id)).toBe(true);
    expect(events).toContainEqual({ type: 'recovery', conversationId: id });
    expect(counts.commits(id)).toBe(0);
    const lookupsWhenWaiting = counts.lookups(id);

    // While waiting: sends stay pending, syncs and flushes make no request at all.
    await phone.client.send(id, { text: 'queued 2' });
    for (let i = 0; i < 3; i++) await phone.client.syncConversation(id);
    await phone.client.reconcile(id);
    await phone.client.flushOutbox();
    expect(counts.lookups(id)).toBe(lookupsWhenWaiting);
    expect(counts.commits(id)).toBe(0);
    expect(await pendingTexts(phone.client, id)).toEqual(['queued 1', 'queued 2']);
    // Never reported as sent: the server has only the creation message.
    const history = await phone.transport.history(id, { limit: 10 });
    expect(history.items).toHaveLength(1);

    // An event for another conversation, or an irrelevant event, does not trigger recovery.
    phone.client.handleRealtime('mls.commit', {
      conversationId: other,
      epoch: 9,
      version: 9,
    });
    phone.client.handleRealtime('message.read', {
      conversationId: id,
      ogcId: user.ogcId as OgcId,
      seq: 1,
    });
    await phone.client.syncConversation(id);
    expect(counts.lookups(id)).toBe(lookupsWhenWaiting);

    // Relevant events while still alone: one re-check (a lookup, no commit), then waiting again.
    phone.client.handleRealtime('devices.changed', { conversationId: id });
    phone.client.handleRealtime('devices.changed', { conversationId: id });
    phone.client.handleRealtime('group.member_joined', {
      conversationId: id,
      version: 1,
      ogcId: user.ogcId as OgcId,
    });
    await phone.client.syncConversation(id); // runs after the scheduled work (same lock)
    expect(counts.lookups(id)).toBe(lookupsWhenWaiting + 1);
    expect(counts.commits(id)).toBe(0);
    expect(phone.client.awaitingAnotherDevice(id)).toBe(true);

    // Other conversations keep working meanwhile.
    expect((await phone.client.send(other, { text: 'unaffected' })).state).toBe('ok');

    // A second device joins (a normal external join), which publishes a commit.
    const laptop = await newDevice(t, baseUrl, user);
    await laptop.client.syncConversation(id);
    const server = await phone.transport.mlsGroup(id);
    expect(server.members).toHaveLength(2);
    phone.client.handleRealtime('mls.commit', {
      conversationId: id,
      epoch: server.epoch,
      version: 0,
    });

    // The phone resyncs by itself (one commit), stops waiting and sends its queue.
    await eventually(
      () => phone.client.awaitingAnotherDevice(id),
      (waiting) => !waiting,
      15_000,
    );
    await eventually(
      async () => pendingTexts(phone.client, id),
      (texts) => texts.length === 0,
      15_000,
    );
    expect(counts.commits(id)).toBe(1);
    expect(
      await t.prisma.mlsCommit.count({
        where: {
          conversationId: id,
          senderDeviceKeyId: phone.client.deviceKeyId ?? '',
          resync: true,
        },
      }),
    ).toBe(1);
    expect(events.filter((e) => e.type === 'recovery' && e.conversationId === id).length).toBe(2);

    // The laptop receives the queued messages.
    await laptop.client.syncConversation(id);
    const laptopTexts = (await laptop.client.messages(id)).map((m) => m.payload?.text);
    expect(laptopTexts).toEqual(expect.arrayContaining(['queued 1', 'queued 2']));

    // Exactly one "couldn't be checked" warning on the phone; none about the phone on the laptop.
    expect(
      (await phone.client.groupSecurity(id)).filter((e) => e.change === 'resynced'),
    ).toHaveLength(1);
    expect(pendingGroupWarnings(await laptop.client.groupSecurity(id))).toEqual([]);
  }, 120_000);

  it('after a restart, finds out again with one attempt and keeps the persisted queue pending', async () => {
    const user = await signedInUser(t, 'Restart');
    const phone = await newDevice(t, baseUrl, user);
    const id = await soloGroup(user, phone, 'Restart');
    await phone.store.delete(`group:${id}`);
    await phone.client.send(id, { text: 'before restart' });
    expect(phone.client.awaitingAnotherDevice(id)).toBe(true);

    // A new engine on the same device storage: nothing about the waiting state was persisted.
    const restarted = new MessagingClient(phone.transport, phone.store, user.ogcId);
    await restarted.start();
    expect(restarted.awaitingAnotherDevice(id)).toBe(false);
    const counts = countRequests(phone); // the transport is shared with the restarted engine
    await restarted.syncConversation(id);
    expect(restarted.awaitingAnotherDevice(id)).toBe(true);
    expect(counts.lookups(id)).toBe(1);
    expect(counts.commits(id)).toBe(0);
    await restarted.flushOutbox();
    await restarted.syncConversation(id);
    expect(counts.lookups(id)).toBe(1);
    expect(counts.commits(id)).toBe(0);
    expect(await pendingTexts(restarted, id)).toEqual(['before restart']);
    await restarted.wipe();
  }, 120_000);
});
