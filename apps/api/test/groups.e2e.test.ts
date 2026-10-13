import { MlsGroup, fromBase64, messageAad } from '@ogc/e2ee';
import { TransportError } from '@ogc/messaging';
import type { ConversationView, DirectoryDevice, ReceivedInvitationView } from '@ogc/types';
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
 * Group end-to-end encryption with real MLS cryptography: every device runs
 * the shared `@ogc/messaging` engine against a live API and PostgreSQL.
 * Covers group creation, invitations, multi-device, removal (cryptographic
 * cut-off), late joiners, policies and what the server can observe.
 */
describe('end-to-end encrypted groups', () => {
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

  const SECRET = 'Launch window moved to 04:20 — tell nobody';

  const textsOf = async (device: TestDevice, conversationId: string) =>
    (await device.client.messages(conversationId))
      .filter((m) => m.state !== 'failed')
      .map((m) => m.payload?.text ?? `[${m.state}]`);

  async function acceptInvitation(user: TestUser, conversationId: string): Promise<void> {
    const list = await user.as(request(t.server).get('/api/v1/invitations')).expect(200);
    const invitation = (list.body as ReceivedInvitationView[]).find(
      (i) => i.conversationId === conversationId,
    );
    expect(invitation).toBeDefined();
    await user
      .as(request(t.server).post(`/api/v1/invitations/${invitation?.id ?? ''}/accept`))
      .expect(200);
  }

  /** Raw API calls from an encryption-ready device session (bypassing the engine). */
  const fromDevice = (device: TestDevice, req: request.Test): request.Test =>
    req.set('Authorization', `Bearer ${device.token}`).set('X-Forwarded-For', '10.9.9.9');

  async function serverBytes(): Promise<Buffer[]> {
    const rows = await t.prisma.$queryRaw<{ data: Uint8Array | null }[]>`
      SELECT ciphertext AS data FROM messages
      UNION ALL SELECT data FROM mls_commits
      UNION ALL SELECT data FROM mls_welcomes
      UNION ALL SELECT group_info FROM conversations
      UNION ALL SELECT convert_to(detail::text, 'UTF8') FROM conversation_events
      UNION ALL SELECT convert_to(data::text, 'UTF8') FROM notifications
      UNION ALL SELECT convert_to(coalesce(metadata::text, ''), 'UTF8') FROM audit_events`;
    return rows.flatMap((r) => (r.data ? [Buffer.from(r.data)] : []));
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
  }, 120_000);

  afterAll(async () => {
    await t.close();
  });

  it('creates a group, invites contacts and delivers encrypted messages to every member', async () => {
    const created = await alice
      .as(request(t.server).post('/api/v1/groups'))
      .send({
        name: 'Launch crew',
        description: 'Ops',
        invite: [bob.ogcId, carol.ogcId, dave.ogcId],
      })
      .expect(201);
    const body = created.body as { conversation: ConversationView; invited: string[] };
    groupId = body.conversation.id;
    expect(body.conversation.type).toBe('GROUP');
    expect(body.conversation.group).toMatchObject({
      name: 'Launch crew',
      myRole: 'OWNER',
      memberCount: 1,
    });
    // Dave is not Alice's contact: silently skipped (no invitation, nothing revealed).
    expect(body.invited.sort()).toEqual([bob.ogcId, carol.ogcId].sort());

    await acceptInvitation(bob, groupId);
    await acceptInvitation(carol, groupId);

    await aliceDevice.client.refreshConversations();
    await aliceDevice.client.send(groupId, { text: SECRET, mentions: [bob.ogcId] });
    await bobDevice.client.syncConversation(groupId);
    await carolDevice.client.syncConversation(groupId);
    expect(await textsOf(bobDevice, groupId)).toEqual([SECRET]);
    expect(await textsOf(carolDevice, groupId)).toEqual([SECRET]);

    await carolDevice.client.send(groupId, { text: 'Copy that' });
    await aliceDevice.client.syncConversation(groupId);
    await bobDevice.client.syncConversation(groupId);
    expect(await textsOf(aliceDevice, groupId)).toEqual([SECRET, 'Copy that']);
    expect(await textsOf(bobDevice, groupId)).toEqual([SECRET, 'Copy that']);

    // The MLS tree holds exactly the members' devices, recorded by the server.
    const conversation = await t.prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    expect(new Set(conversation.mlsMemberUserIds)).toEqual(
      new Set([alice.userId, bob.userId, carol.userId]),
    );

    // Mentions are declared beside the ciphertext: Bob gets an in-app notification.
    const mention = await t.prisma.notification.findFirst({
      where: { userId: bob.userId, type: 'MENTION' },
    });
    expect(mention?.data).toMatchObject({ conversationId: groupId, groupName: 'Launch crew' });
  }, 60_000);

  it('never gives the server any plaintext', async () => {
    const needle = Buffer.from('Launch window moved');
    for (const bytes of await serverBytes()) expect(bytes.includes(needle)).toBe(false);
    const bodies = [aliceDevice, bobDevice, carolDevice].flatMap((d) => d.transport.sentBodies);
    for (const body of bodies) expect(body).not.toContain('Launch window moved');
  });

  it('cuts a removed member off cryptographically', async () => {
    // A copy of Carol's device state, as if she kept it (e.g. a stolen or tampered device).
    const stolen = await carolDevice.store.getBytes(`group:${groupId}`);
    expect(stolen).toBeDefined();

    await alice
      .as(request(t.server).delete(`/api/v1/groups/${groupId}/members/${carol.ogcId}`))
      .expect(204);

    // The server refuses new content until the members' clients remove her devices from MLS.
    const raw = await fromDevice(
      bobDevice,
      request(t.server).post(`/api/v1/conversations/${groupId}/messages`),
    )
      .send({ clientMessageId: crypto.randomUUID(), epoch: 1, ciphertext: 'AAAA' })
      .expect(409);
    expect((raw.body as { code: string }).code).toBe('MLS_MEMBERSHIP_STALE');

    // Bob's engine handles it: removes Carol's devices (commit), then sends.
    const AFTER = 'Carol is out; new rendezvous is pier 9';
    await bobDevice.client.send(groupId, { text: AFTER });
    await aliceDevice.client.syncConversation(groupId);
    expect(await textsOf(aliceDevice, groupId)).toContain(AFTER);
    const conversation = await t.prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    expect(conversation.mlsMemberUserIds).not.toContain(carol.userId);

    // Carol's own engine erases the group when the server no longer recognizes her.
    await carolDevice.client.syncConversation(groupId);
    expect(await carolDevice.client.messages(groupId)).toEqual([]);
    await expect(carolDevice.transport.sync(groupId, 0)).rejects.toMatchObject({ status: 404 });

    // With her old state and every public record, she still cannot read the new message.
    const directory = await aliceDevice.transport.directory(groupId);
    const toCrypto = (devices: DirectoryDevice[]) =>
      devices.map((d) => ({
        ogcId: d.ogcId,
        deviceKeyId: d.deviceKeyId,
        signaturePublicKey: fromBase64(d.signaturePublicKey),
      }));
    const old = await MlsGroup.restore(stolen ?? new Uint8Array(), toCrypto(directory));
    const removal = await t.prisma.mlsCommit.findFirstOrThrow({
      where: { conversationId: groupId, epoch: old.epoch },
    });
    const message = await t.prisma.message.findFirstOrThrow({
      where: { conversationId: groupId },
      orderBy: { seq: 'desc' },
    });
    const ciphertext = Buffer.from(message.ciphertext ?? new Uint8Array()).toString('base64');
    const aad = messageAad(groupId, message.clientMessageId);
    let processed: MlsGroup | undefined;
    try {
      processed = (await old.processCommit(Buffer.from(removal.data).toString('base64'))).group;
    } catch {
      processed = undefined;
    }
    if (processed) {
      expect(processed.members().some((m) => m.ogcId === carol.ogcId)).toBe(false);
      await expect(processed.decrypt(ciphertext, aad)).rejects.toThrow();
    }
    await expect(old.decrypt(ciphertext, aad)).rejects.toThrow();
  }, 60_000);

  it('rejects replayed and stale MLS commits', async () => {
    const latest = await t.prisma.mlsCommit.findFirstOrThrow({
      where: { conversationId: groupId },
      orderBy: { epoch: 'desc' },
    });
    const conversation = await t.prisma.conversation.findUniqueOrThrow({ where: { id: groupId } });
    const replay = await fromDevice(
      aliceDevice,
      request(t.server).post(`/api/v1/conversations/${groupId}/mls/commits`),
    ).send({
      epoch: Number(latest.epoch),
      commit: Buffer.from(latest.data).toString('base64'),
      groupInfo: Buffer.from(conversation.groupInfo ?? new Uint8Array()).toString('base64'),
    });
    expect([403, 409, 422]).toContain(replay.status);
    // A removed member cannot submit anything at all.
    await fromDevice(
      carolDevice,
      request(t.server).post(`/api/v1/conversations/${groupId}/mls/commits`),
    )
      .send({ epoch: 0, commit: 'AAAA', groupInfo: 'AAAA' })
      .expect(404);
  });

  it('lets a late joiner read only what was sent after joining', async () => {
    const link = await alice
      .as(request(t.server).post(`/api/v1/groups/${groupId}/invite-links`))
      .send({ expiresInHours: 1, maxUses: 1 })
      .expect(201);
    const token = (link.body as { token: string }).token;
    await dave.as(request(t.server).post('/api/v1/invite-links/join')).send({ token }).expect(200);
    const daveDevice = await newDevice(t, baseUrl, dave);

    const LATER = 'Welcome Dave — briefing at 09:00';
    await aliceDevice.client.send(groupId, { text: LATER });
    await daveDevice.client.syncConversation(groupId);
    expect(await textsOf(daveDevice, groupId)).toEqual([LATER]);
    const timeline = await daveDevice.client.timeline(groupId);
    expect(timeline.map((e) => e.type)).toContain('MEMBER_JOINED');
    // Older history is not even delivered to him.
    const history = await daveDevice.transport.history(groupId, { limit: 100 });
    expect(history.items.map((m) => m.id)).toHaveLength(1);
  }, 60_000);

  it('adds a member’s new device and keeps every device in sync', async () => {
    const bobPhone = await newDevice(t, baseUrl, bob);
    const NEXT = 'Second device check';
    await aliceDevice.client.send(groupId, { text: NEXT });
    await bobPhone.client.syncConversation(groupId);
    await bobDevice.client.syncConversation(groupId);
    expect(await textsOf(bobPhone, groupId)).toContain(NEXT);
    expect(await textsOf(bobDevice, groupId)).toContain(NEXT);
  }, 60_000);

  it('enforces post policies and archive state on encrypted content', async () => {
    await alice
      .as(request(t.server).patch(`/api/v1/groups/${groupId}`))
      .send({ postPolicy: 'ADMINS' })
      .expect(200);
    await expect(bobDevice.client.send(groupId, { text: 'not allowed' })).rejects.toBeInstanceOf(
      TransportError,
    );
    await alice
      .as(request(t.server).patch(`/api/v1/groups/${groupId}`))
      .send({ postPolicy: 'ALL_MEMBERS' })
      .expect(200);
    await alice.as(request(t.server).post(`/api/v1/groups/${groupId}/archive`)).expect(204);
    const archived = await fromDevice(
      bobDevice,
      request(t.server).post(`/api/v1/conversations/${groupId}/messages`),
    )
      .send({ clientMessageId: crypto.randomUUID(), epoch: 1, ciphertext: 'AAAA' })
      .expect(403);
    expect((archived.body as { code: string }).code).toBe('ARCHIVED');
    await alice.as(request(t.server).post(`/api/v1/groups/${groupId}/unarchive`)).expect(204);
  }, 60_000);

  it('lets moderators remove others’ messages for everyone, recorded without content', async () => {
    await bobDevice.client.syncConversation(groupId);
    const target = (await bobDevice.client.messages(groupId)).find((m) => m.mine && m.id);
    expect(target?.id).toBeDefined();
    // Bob (member) cannot remove Alice's message; Alice (owner) can remove Bob's.
    const alicesMessage = (await bobDevice.client.messages(groupId)).find((m) => !m.mine && m.id);
    await bob
      .as(request(t.server).delete(`/api/v1/messages/${alicesMessage?.id ?? ''}?scope=everyone`))
      .expect(403);
    await alice
      .as(request(t.server).delete(`/api/v1/messages/${target?.id ?? ''}?scope=everyone`))
      .expect(204);
    const event = await t.prisma.conversationEvent.findFirst({
      where: { conversationId: groupId, type: 'MESSAGE_REMOVED' },
    });
    expect(event?.detail).toEqual({ messageId: target?.id });
    await bobDevice.client.syncConversation(groupId);
    const after = (await bobDevice.client.messages(groupId)).find((m) => m.id === target?.id);
    expect(after?.state).toBe('deleted');
  }, 60_000);

  it('erases the group everywhere when the owner deletes it', async () => {
    await alice.as(request(t.server).delete(`/api/v1/groups/${groupId}`)).expect(204);
    expect(await t.prisma.conversation.findUnique({ where: { id: groupId } })).toBeNull();
    expect(await t.prisma.message.count({ where: { conversationId: groupId } })).toBe(0);
    await bobDevice.client.syncConversation(groupId);
    expect(await bobDevice.client.messages(groupId)).toEqual([]);
    expect(bobDevice.client.conversation(groupId)).toBeUndefined();
  }, 60_000);
});
