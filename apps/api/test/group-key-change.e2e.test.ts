import { MessagingClient, pendingGroupWarnings } from '@ogc/messaging';
import type { ConversationView, ReceivedInvitationView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDevice, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/**
 * Group key-change warnings with real MLS cryptography: every device runs the shared engine
 * against the live API, and each derives warnings from its own verified MLS tree.
 */
describe('group key-change warnings', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let dave: TestUser;
  let aliceDevice: TestDevice;
  let bobDevice: TestDevice;
  let carolDevice: TestDevice;
  let groupId: string;

  const pending = async (device: TestDevice) =>
    pendingGroupWarnings(await device.client.groupSecurity(groupId));
  /** The same device's storage opened by a new engine (an app restart). */
  const restarted = async (device: TestDevice, user: TestUser) => {
    const client = new MessagingClient(device.transport, device.store, user.ogcId);
    await client.start();
    return client;
  };

  async function acceptInvitation(user: TestUser, conversationId: string): Promise<void> {
    const list = await user.as(request(t.server).get('/api/v1/invitations')).expect(200);
    const invitation = (list.body as ReceivedInvitationView[]).find(
      (i) => i.conversationId === conversationId,
    );
    await user
      .as(request(t.server).post(`/api/v1/invitations/${invitation?.id ?? ''}/accept`))
      .expect(200);
  }

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob, carol, dave] = await Promise.all([
      signedInUser(t, 'Alice'),
      signedInUser(t, 'Bob'),
      signedInUser(t, 'Carol'),
      signedInUser(t, 'Dave'),
    ]);
    await makeContacts(t, alice, bob);
    await makeContacts(t, alice, carol);
    [aliceDevice, bobDevice, carolDevice] = await Promise.all([
      newDevice(t, baseUrl, alice),
      newDevice(t, baseUrl, bob),
      newDevice(t, baseUrl, carol),
    ]);
    const created = await alice
      .as(request(t.server).post('/api/v1/groups'))
      .send({ name: 'Key crew', invite: [bob.ogcId, carol.ogcId] })
      .expect(201);
    groupId = (created.body as { conversation: ConversationView }).conversation.id;
    await acceptInvitation(bob, groupId);
    await acceptInvitation(carol, groupId);
    await aliceDevice.client.refreshConversations();
    await aliceDevice.client.send(groupId, { text: 'Hello crew' });
    await bobDevice.client.syncConversation(groupId);
    await carolDevice.client.syncConversation(groupId);
  }, 120_000);

  afterAll(async () => {
    await t.close();
  });

  it('records new members as ordinary, confirmed changes — not warnings', async () => {
    const events = await aliceDevice.client.groupSecurity(groupId);
    expect(events.filter((e) => e.change === 'member-joined').map((e) => e.ogcId)).toEqual(
      expect.arrayContaining([bob.ogcId, carol.ogcId]),
    );
    expect(events.every((e) => e.level === 'confirmed' && e.acknowledged)).toBe(true);
    expect(await pending(aliceDevice)).toEqual([]);
    // Devices that joined from a Welcome trust what they found, silently.
    expect(await pending(bobDevice)).toEqual([]);
    expect(await pending(carolDevice)).toEqual([]);
    // Group messaging is unaffected.
    expect((await carolDevice.client.messages(groupId)).map((m) => m.payload?.text)).toEqual([
      'Hello crew',
    ]);
  });

  it('flags a member’s new device key, from the authenticated commit, on every device', async () => {
    await newDevice(t, baseUrl, bob);
    // Alice's next send adds the new device (her own commit, from the directory).
    await aliceDevice.client.send(groupId, { text: 'After Bob’s new device' });
    await carolDevice.client.syncConversation(groupId);
    await bobDevice.client.syncConversation(groupId);

    const forAlice = await pending(aliceDevice);
    expect(forAlice).toEqual([
      expect.objectContaining({ change: 'new-device', level: 'verify', ogcId: bob.ogcId }),
    ]);
    expect(forAlice[0]?.via).toBe('you');
    // Carol verified Alice's commit herself: it names Alice's device as the committer.
    expect(await pending(carolDevice)).toEqual([
      expect.objectContaining({
        change: 'new-device',
        ogcId: bob.ogcId,
        via: 'member',
        by: alice.ogcId,
      }),
    ]);
    // Bob is told about a new device on his own account.
    expect(await pending(bobDevice)).toEqual([
      expect.objectContaining({ change: 'new-device', ogcId: bob.ogcId }),
    ]);
  }, 60_000);

  it('does not repeat a warning on re-sync, reconcile, retries or restart', async () => {
    await aliceDevice.client.syncConversation(groupId);
    await aliceDevice.client.reconcile(groupId);
    await carolDevice.client.syncConversation(groupId);
    await carolDevice.client.syncConversation(groupId);
    expect(await pending(aliceDevice)).toHaveLength(1);
    expect(await pending(carolDevice)).toHaveLength(1);

    const carolAgain = await restarted(carolDevice, carol);
    await carolAgain.syncAll();
    expect(pendingGroupWarnings(await carolAgain.groupSecurity(groupId))).toHaveLength(1);
  }, 60_000);

  it('stays dismissed after acknowledging, also after a restart', async () => {
    await carolDevice.client.acknowledgeGroupSecurity(groupId);
    expect(await pending(carolDevice)).toEqual([]);
    const carolAgain = await restarted(carolDevice, carol);
    await carolAgain.syncConversation(groupId);
    expect(pendingGroupWarnings(await carolAgain.groupSecurity(groupId))).toEqual([]);
  }, 60_000);

  it('recovers a device that lost its group state by resync, warning only that device', async () => {
    const carolKey = carolDevice.client.deviceKeyId ?? '';
    const once = async () =>
      (await carolDevice.transport.mlsGroup(groupId)).members.filter((id) => id === carolKey);
    const alicePending = (await pending(aliceDevice)).length;
    const bobPending = (await pending(bobDevice)).length;
    expect(await once()).toHaveLength(1);

    // Carol's device loses its group state while it is still in the published tree.
    await carolDevice.store.delete(`group:${groupId}`);
    await carolDevice.client.send(groupId, { text: 'Carol is back' });
    expect(await once()).toHaveLength(1);
    // Her device is told that changes while it was away could not be checked.
    expect(await pending(carolDevice)).toEqual([
      expect.objectContaining({ change: 'resynced', level: 'unconfirmed', via: 'rejoin' }),
    ]);

    // The others read her message, and her unchanged key is no "new device" for them.
    await aliceDevice.client.syncConversation(groupId);
    await bobDevice.client.syncConversation(groupId);
    expect((await aliceDevice.client.messages(groupId)).map((m) => m.payload?.text)).toContain(
      'Carol is back',
    );
    expect(await pending(aliceDevice)).toHaveLength(alicePending);
    expect(await pending(bobDevice)).toHaveLength(bobPending);

    // She receives again.
    await aliceDevice.client.send(groupId, { text: 'Welcome back, Carol' });
    await carolDevice.client.syncConversation(groupId);
    expect((await carolDevice.client.messages(groupId)).map((m) => m.payload?.text)).toContain(
      'Welcome back, Carol',
    );

    // Repeated syncs and reconciles: no second warning, no duplicate leaf.
    await carolDevice.client.syncConversation(groupId);
    await carolDevice.client.reconcile(groupId);
    await aliceDevice.client.syncConversation(groupId);
    expect(await pending(carolDevice)).toHaveLength(1);
    expect(
      (await carolDevice.client.groupSecurity(groupId)).filter((e) => e.change === 'resynced'),
    ).toHaveLength(1);
    expect(await once()).toHaveLength(1);
    expect(await pending(aliceDevice)).toHaveLength(alicePending);
  }, 60_000);

  it('recovers through rejoin() when a commit arrives from a future epoch', async () => {
    const carolKey = carolDevice.client.deviceKeyId ?? '';
    const groupState = `group:${groupId}`;
    // Carol's device keeps a copy of its current state…
    const stale = await carolDevice.store.getBytes(groupState);
    if (!stale) throw new Error('Carol has no group state');
    const resyncedBefore = (await carolDevice.client.groupSecurity(groupId)).filter(
      (e) => e.change === 'resynced',
    ).length;
    // …the group moves on two epochs (Alice signs in on two more devices)…
    await newDevice(t, baseUrl, alice);
    await aliceDevice.client.send(groupId, { text: 'Epoch one' });
    await carolDevice.client.syncConversation(groupId);
    await newDevice(t, baseUrl, alice);
    // …and the device falls back to the old state: the next commit is from a future epoch.
    await carolDevice.store.setBytes(groupState, stale);
    await aliceDevice.client.send(groupId, { text: 'Epoch two' });
    await carolDevice.client.syncConversation(groupId);

    expect((await carolDevice.transport.mlsGroup(groupId)).members).toContain(carolKey);
    expect(
      (await carolDevice.transport.mlsGroup(groupId)).members.filter((id) => id === carolKey),
    ).toHaveLength(1);
    await aliceDevice.client.send(groupId, { text: 'After the rejoin' });
    await carolDevice.client.syncConversation(groupId);
    expect((await carolDevice.client.messages(groupId)).map((m) => m.payload?.text)).toContain(
      'After the rejoin',
    );
    expect(
      (await carolDevice.client.groupSecurity(groupId)).filter((e) => e.change === 'resynced'),
    ).toHaveLength(resyncedBefore + 1);
    // Other members never see Carol's unchanged key as a new device.
    await aliceDevice.client.syncConversation(groupId);
    expect(
      (await aliceDevice.client.groupSecurity(groupId)).filter(
        (e) => e.change === 'new-device' && e.ogcId === carol.ogcId,
      ),
    ).toEqual([]);
  }, 90_000);

  it('gives non-members nothing, and stores nothing readable', async () => {
    const daveDevice = await newDevice(t, baseUrl, dave);
    expect(await daveDevice.client.groupSecurity(groupId)).toEqual([]);
    await daveDevice.client.syncConversation(groupId).catch(() => undefined);
    expect(await daveDevice.client.groupSecurity(groupId)).toEqual([]);
    // The record is sealed on the member's device: no account IDs in the clear.
    for (const raw of carolDevice.storage.rawValues()) {
      expect(Buffer.from(raw).toString('latin1')).not.toContain(bob.ogcId);
    }
  }, 60_000);

  it('erases the record when the member is removed from the group', async () => {
    const alicePending = (await pending(aliceDevice)).length;
    await alice
      .as(request(t.server).delete(`/api/v1/groups/${groupId}/members/${carol.ogcId}`))
      .expect(204);
    await carolDevice.client.syncConversation(groupId);
    expect(await carolDevice.client.groupSecurity(groupId)).toEqual([]);
    // Alice's device records Carol leaving as an ordinary change.
    await aliceDevice.client.send(groupId, { text: 'Carol removed' });
    const events = await aliceDevice.client.groupSecurity(groupId);
    expect(events.some((e) => e.change === 'member-left' && e.ogcId === carol.ogcId)).toBe(true);
    // An ordinary removal adds no warning.
    expect(await pending(aliceDevice)).toHaveLength(alicePending);
  }, 60_000);
});
