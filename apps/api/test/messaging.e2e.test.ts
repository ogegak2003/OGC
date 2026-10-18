import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MlsGroup, generateSigningKeyPair, messageAad } from '@ogc/e2ee';
import { TransportError } from '@ogc/messaging';
import type { ConversationView, MessageView } from '@ogc/types';
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
 * End-to-end encrypted messaging, exercised the way real clients use it: each
 * device runs the shared `@ogc/messaging` engine (real MLS cryptography)
 * against a live API instance and PostgreSQL. Assertions check both what
 * participants can read and what the server could have seen.
 */
describe('end-to-end encrypted messaging', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let mallory: TestUser;
  let aliceDevice: TestDevice;
  let bobDevice: TestDevice;
  let conversation: ConversationView;

  const SECRET = 'Meet at the north gate at 19:40 — code 7731';

  const textsOf = async (device: TestDevice, conversationId: string) =>
    (await device.client.messages(conversationId))
      .filter((m) => m.state !== 'failed')
      .map((m) => m.payload?.text ?? `[${m.state}]`);

  /** Every byte the server stores for messaging, to prove plaintext never reached it. */
  async function serverBytes(): Promise<Buffer[]> {
    const rows = await t.prisma.$queryRaw<{ data: Uint8Array | null }[]>`
      SELECT ciphertext AS data FROM messages
      UNION ALL SELECT data FROM mls_commits
      UNION ALL SELECT data FROM mls_welcomes
      UNION ALL SELECT data FROM key_packages
      UNION ALL SELECT group_info FROM conversations`;
    return rows.flatMap((r) => (r.data ? [Buffer.from(r.data)] : []));
  }

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob, carol, mallory] = await Promise.all([
      signedInUser(t, 'Alice'),
      signedInUser(t, 'Bob'),
      signedInUser(t, 'Carol'),
      signedInUser(t, 'Mallory'),
    ]);
    await makeContacts(t, alice, bob);
    await makeContacts(t, bob, carol);
    aliceDevice = await newDevice(t, baseUrl, alice);
    bobDevice = await newDevice(t, baseUrl, bob);
    conversation = await aliceDevice.client.openDirect(bob.ogcId);
  });

  afterAll(async () => {
    await t.close();
  });

  it('delivers a message that only the participants’ devices can read', async () => {
    await aliceDevice.client.send(conversation.id, { text: SECRET });
    await bobDevice.client.processWelcomes();
    await bobDevice.client.syncConversation(conversation.id);
    expect(await textsOf(bobDevice, conversation.id)).toEqual([SECRET]);

    const [received] = await bobDevice.client.messages(conversation.id);
    expect(received).toMatchObject({ senderOgcId: alice.ogcId, mine: false, state: 'ok' });

    // The server stored and relayed only ciphertext and public MLS data.
    const needle = Buffer.from('north gate');
    for (const bytes of await serverBytes()) expect(bytes.includes(needle)).toBe(false);
    for (const body of aliceDevice.transport.sentBodies) expect(body).not.toContain('north gate');
    const stored = await t.prisma.message.findFirstOrThrow({
      where: { conversationId: conversation.id },
    });
    expect(stored.ciphertext?.length).toBeGreaterThan(SECRET.length);

    // The devices keep plaintext only in their sealed local stores.
    for (const device of [aliceDevice, bobDevice]) {
      for (const raw of device.storage.rawValues())
        expect(Buffer.from(raw).includes(needle)).toBe(false);
    }
  });

  it('lets both people reply and tracks delivery and read state', async () => {
    await bobDevice.client.send(conversation.id, { text: 'On my way' });
    await aliceDevice.client.syncConversation(conversation.id);
    expect(await textsOf(aliceDevice, conversation.id)).toEqual([SECRET, 'On my way']);

    // Alice's sync acknowledged Bob's message as delivered; now she reads it.
    await aliceDevice.client.markRead(conversation.id);
    const fromBob = await bobDevice.transport.conversation(conversation.id);
    const bobsMessage = (await bobDevice.client.messages(conversation.id)).at(-1);
    expect(fromBob.peerLastDeliveredSeq).toBeGreaterThanOrEqual(bobsMessage?.seq ?? Infinity);
    expect(fromBob.peerLastReadSeq).toBeGreaterThanOrEqual(bobsMessage?.seq ?? Infinity);
    expect((await aliceDevice.transport.conversation(conversation.id)).unreadCount).toBe(0);
  });

  it('a new device joins by itself (external commit) and reads only messages sent after it joined', async () => {
    const bobPhone = await newDevice(t, baseUrl, bob);
    await bobPhone.client.syncConversation(conversation.id);
    // Alice's group is one epoch behind; the engine catches up and retries automatically.
    await aliceDevice.client.send(conversation.id, { text: 'Hello to all your devices' });
    await bobPhone.client.syncConversation(conversation.id);
    await bobDevice.client.syncConversation(conversation.id);

    const phoneView = await bobPhone.client.messages(conversation.id);
    expect(phoneView.at(-1)?.payload?.text).toBe('Hello to all your devices');
    expect(phoneView[0]?.state).toBe('unavailable');
    expect((await bobDevice.client.messages(conversation.id)).at(-1)?.payload?.text).toBe(
      'Hello to all your devices',
    );
  });

  it('existing members add a new device with a Welcome', async () => {
    const bobTablet = await newDevice(t, baseUrl, bob);
    await aliceDevice.client.reconcile(conversation.id);
    expect(await t.prisma.mlsWelcome.count({ where: { conversationId: conversation.id } })).toBe(1);
    await bobTablet.client.processWelcomes();
    expect(await t.prisma.mlsWelcome.count({ where: { conversationId: conversation.id } })).toBe(0);

    await aliceDevice.client.send(conversation.id, { text: 'Tablet check' });
    await bobTablet.client.syncConversation(conversation.id);
    expect((await bobTablet.client.messages(conversation.id)).at(-1)?.payload?.text).toBe(
      'Tablet check',
    );
  });

  it('removes a logged-out device from the group so it cannot read new messages', async () => {
    const bobLaptop = await newDevice(t, baseUrl, bob);
    await bobLaptop.client.syncConversation(conversation.id);
    const laptopKey = bobLaptop.client.deviceKeyId ?? '';
    expect((await aliceDevice.transport.mlsGroup(conversation.id)).members).toContain(laptopKey);

    await request(t.server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${bobLaptop.token}`)
      .expect(204);
    // Logout revoked the device key: it disappears from the directory…
    const directory = await aliceDevice.transport.directory(conversation.id);
    expect(directory.find((d) => d.deviceKeyId === laptopKey)?.active).toBe(false);
    // …and the next membership check removes it from the MLS group.
    await aliceDevice.client.reconcile(conversation.id);
    expect((await aliceDevice.transport.mlsGroup(conversation.id)).members).not.toContain(
      laptopKey,
    );
    // The revoked device can no longer call the API at all.
    await expect(bobLaptop.transport.sync(conversation.id, 0)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('keeps conversations private from non-participants (no IDOR)', async () => {
    const malloryDevice = await newDevice(t, baseUrl, mallory);
    const id = conversation.id;
    for (const call of [
      () => malloryDevice.transport.conversation(id),
      () => malloryDevice.transport.sync(id, 0),
      () => malloryDevice.transport.history(id, {}),
      () => malloryDevice.transport.directory(id),
      () => malloryDevice.transport.mlsGroup(id),
      () => malloryDevice.transport.markRead(id, 1),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    const [message] = (await bobDevice.transport.sync(id, 0)).items.filter(
      (i) => i.type === 'message',
    );
    const messageId = message?.type === 'message' ? message.message.id : '';
    await expect(malloryDevice.transport.react(messageId, 'heart', true)).rejects.toMatchObject({
      status: 404,
    });
    await expect(malloryDevice.transport.deleteMessage(messageId, 'self')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      malloryDevice.transport.editMessage(messageId, { epoch: 0, ciphertext: 'AAAA' }),
    ).rejects.toMatchObject({
      status: 404,
    });

    // Even with the ciphertext in hand, a device outside the group cannot decrypt it.
    const row = await t.prisma.message.findFirstOrThrow({
      where: { conversationId: id },
      orderBy: { seq: 'desc' },
    });
    const signing = await generateSigningKeyPair();
    const outsider = { ogcId: mallory.ogcId, deviceKeyId: crypto.randomUUID(), signing };
    const forged = await MlsGroup.create(outsider, id, [
      {
        ogcId: mallory.ogcId,
        deviceKeyId: outsider.deviceKeyId,
        signaturePublicKey: signing.publicKey,
      },
    ]);
    await expect(
      forged.decrypt(
        Buffer.from(row.ciphertext ?? []).toString('base64'),
        messageAad(id, row.clientMessageId),
      ),
    ).rejects.toThrow();
  });

  it('never stores a retried submission twice (idempotency)', async () => {
    const captured: Parameters<TestDevice['transport']['sendMessage']>[1][] = [];
    const original = aliceDevice.transport.sendMessage;
    aliceDevice.transport.sendMessage = async (id, body) => {
      captured.push(body);
      return original(id, body);
    };
    try {
      const sent = await aliceDevice.client.send(conversation.id, { text: 'Exactly once' });
      const body = captured[0];
      if (!body) throw new Error('nothing captured');
      // A client that never saw the response retries with the same client message ID.
      const retry = await original(conversation.id, body);
      expect(retry.id).toBe(sent.id);
      expect(
        await t.prisma.message.count({ where: { clientMessageId: body.clientMessageId } }),
      ).toBe(1);
    } finally {
      aliceDevice.transport.sendMessage = original;
    }
  });

  it('supports replies, edits, reactions and both kinds of delete', async () => {
    const original = await aliceDevice.client.send(conversation.id, { text: 'Lunch at 1?' });
    const originalId = original.id ?? '';
    await bobDevice.client.syncConversation(conversation.id);
    const reply = await bobDevice.client.send(conversation.id, {
      text: 'Yes!',
      replyToId: originalId,
    });
    expect(reply.replyToId).toBe(originalId);

    // Edit (sender only): the recipient sees the new revision.
    await aliceDevice.client.edit(conversation.id, originalId, 'Lunch at 1:30?');
    await bobDevice.client.syncConversation(conversation.id);
    const edited = (await bobDevice.client.messages(conversation.id)).find(
      (m) => m.id === originalId,
    );
    expect(edited).toMatchObject({ revision: 1, payload: { text: 'Lunch at 1:30?' } });
    expect(edited?.editedAt).not.toBeNull();
    await expect(bobDevice.client.edit(conversation.id, originalId, 'hijacked')).rejects.toThrow();
    await expect(
      bobDevice.transport.editMessage(originalId, { epoch: 0, ciphertext: 'AAAA' }),
    ).rejects.toMatchObject({
      status: 403,
    });

    // Reactions: one of each type per person, idempotent, from a fixed set.
    await bobDevice.client.react(conversation.id, originalId, 'heart', true);
    await bobDevice.transport.react(originalId, 'heart', true);
    await aliceDevice.client.syncConversation(conversation.id);
    const reacted = (await aliceDevice.client.messages(conversation.id)).find(
      (m) => m.id === originalId,
    );
    expect(reacted?.reactions).toEqual([{ reaction: 'heart', ogcId: bob.ogcId }]);
    await expect(
      bobDevice.transport.react(originalId, 'poop' as 'heart', true),
    ).rejects.toMatchObject({ status: 400 });

    // Delete for me: hidden on Bob's devices only.
    await bobDevice.client.deleteForMe(conversation.id, reply.id ?? '');
    expect((await bobDevice.client.messages(conversation.id)).some((m) => m.id === reply.id)).toBe(
      false,
    );
    await aliceDevice.client.syncConversation(conversation.id);
    expect(
      (await aliceDevice.client.messages(conversation.id)).some((m) => m.id === reply.id),
    ).toBe(true);

    // Delete for everyone (sender only): ciphertext and reactions are erased everywhere.
    await expect(bobDevice.transport.deleteMessage(originalId, 'everyone')).rejects.toMatchObject({
      status: 403,
    });
    await aliceDevice.client.deleteForEveryone(conversation.id, originalId);
    await bobDevice.client.syncConversation(conversation.id);
    const deleted = (await bobDevice.client.messages(conversation.id)).find(
      (m) => m.id === originalId,
    );
    expect(deleted).toMatchObject({ state: 'deleted', payload: null, reactions: [] });
    const row = await t.prisma.message.findUniqueOrThrow({ where: { id: originalId } });
    expect(row.ciphertext).toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(await t.prisma.messageReaction.count({ where: { messageId: originalId } })).toBe(0);
    // Deleted messages cannot be edited or reacted to.
    await expect(aliceDevice.transport.react(originalId, 'joy', true)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rejects replies that point into another conversation', async () => {
    const bobAndCarol = await bobDevice.client.openDirect(carol.ogcId);
    const elsewhere = (await bobDevice.client.messages(conversation.id)).find(
      (m) => m.state === 'ok' && m.id,
    );
    await expect(
      bobDevice.client.send(bobAndCarol.id, {
        text: 'cross-reference',
        replyToId: elsewhere?.id ?? '',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('forwards by re-encrypting on the device; the server learns only that it was forwarded', async () => {
    const carolDevice = await newDevice(t, baseUrl, carol);
    const bobAndCarol = await bobDevice.client.openDirect(carol.ogcId);
    await bobDevice.client.syncConversation(conversation.id);
    const source = (await bobDevice.client.messages(conversation.id)).find(
      (m) => m.payload?.text === 'Hello to all your devices',
    );
    const forwarded = await bobDevice.client.forward(
      conversation.id,
      source?.id ?? '',
      bobAndCarol.id,
    );
    expect(forwarded.forwarded).toBe(true);
    await carolDevice.client.processWelcomes();
    await carolDevice.client.syncConversation(bobAndCarol.id);
    const received = (await carolDevice.client.messages(bobAndCarol.id)).at(-1);
    expect(received).toMatchObject({
      forwarded: true,
      payload: { text: 'Hello to all your devices' },
    });
    expect(received?.senderOgcId).toBe(bob.ogcId);

    // Forwarding requires access to the source message.
    const malloryDevice = await newDevice(t, baseUrl, mallory);
    await makeContacts(t, mallory, carol);
    const malloryAndCarol = await malloryDevice.client.openDirect(carol.ogcId);
    await expect(
      malloryDevice.client.send(malloryAndCarol.id, {
        text: 'stolen',
        forwardedFromId: source?.id ?? '',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('encrypts attachments on the device and serves ciphertext only to participants', async () => {
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Buffer.from('PIXELS-PLAINTEXT'),
    ]);
    const descriptor = await aliceDevice.client.uploadAttachment(conversation.id, {
      kind: 'IMAGE',
      name: '../../etc/passwd.png',
      mime: 'image/png',
      bytes: png,
    });
    // Before the message is sent, only the uploader can fetch it.
    await expect(bobDevice.transport.downloadAttachment(descriptor.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      aliceDevice.client.send(conversation.id, { text: 'bad name', attachments: [descriptor] }),
    ).rejects.toThrow();
    const safe = { ...descriptor, name: 'holiday.png' };
    await aliceDevice.client.send(conversation.id, { text: 'Photo', attachments: [safe] });
    await bobDevice.client.syncConversation(conversation.id);
    const message = (await bobDevice.client.messages(conversation.id)).at(-1);
    const attachment = message?.payload?.attachments?.[0];
    expect(attachment?.name).toBe('holiday.png');
    expect(await bobDevice.client.openAttachment(attachment ?? safe)).toEqual(png);

    // The stored object is ciphertext with a server-generated name.
    const row = await t.prisma.attachment.findUniqueOrThrow({ where: { id: descriptor.id } });
    expect(row.storageKey).toBe(`attachments/${descriptor.id}.bin`);
    const files = await readdir(join(tmpdir(), 'ogc-test-storage', 'attachments'));
    expect(files).toContain(`${descriptor.id}.bin`);
    const onDisk = await readFile(
      join(tmpdir(), 'ogc-test-storage', 'attachments', `${descriptor.id}.bin`),
    );
    expect(onDisk.includes(Buffer.from('PIXELS-PLAINTEXT'))).toBe(false);

    const malloryDevice = await newDevice(t, baseUrl, mallory, false);
    await expect(malloryDevice.transport.downloadAttachment(descriptor.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      malloryDevice.transport.uploadAttachment(conversation.id, 'FILE', new Uint8Array(64)),
    ).rejects.toMatchObject({ status: 404 });
    // An attachment can only be used once, by its uploader, in its own conversation.
    await expect(
      bobDevice.client.send(conversation.id, { text: 'reuse', attachments: [safe] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects oversized and malformed encrypted payloads', async () => {
    await expect(
      aliceDevice.transport.uploadAttachment(
        conversation.id,
        'IMAGE',
        new Uint8Array(10 * 1024 * 1024 + 17),
      ),
    ).rejects.toMatchObject({ status: 413 });
    const group = await aliceDevice.transport.mlsGroup(conversation.id);
    const bad = await request(t.server)
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${aliceDevice.token}`)
      .send({ clientMessageId: crypto.randomUUID(), epoch: group.epoch, ciphertext: 'AAAAAAAA' });
    expect(bad.status).toBe(400);
    expect((bad.body as { code: string }).code).toBe('INVALID_MLS_MESSAGE');
    const huge = await request(t.server)
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${aliceDevice.token}`)
      .send({
        clientMessageId: crypto.randomUUID(),
        epoch: group.epoch,
        ciphertext: 'A'.repeat(90_000),
      });
    expect(huge.status).toBe(400);
  });

  it('withholds messages from a person who blocked the sender, without revealing the block', async () => {
    await request(t.server)
      .post(`/api/v1/blocks/${alice.ogcId}`)
      .set('Authorization', `Bearer ${bobDevice.token}`)
      .expect(204);
    // Alice can still "send" (the block is not revealed)…
    const sent = await aliceDevice.client.send(conversation.id, { text: 'Are you there?' });
    expect(sent.state).toBe('ok');
    // …but Bob never receives it.
    await bobDevice.client.syncConversation(conversation.id);
    expect(await textsOf(bobDevice, conversation.id)).not.toContain('Are you there?');
    const bobView = await bobDevice.transport.conversation(conversation.id);
    expect(bobView.blockedByMe).toBe(true);
    expect(bobView.lastMessage?.id).not.toBe(sent.id);
    // Bob cannot message someone he blocked.
    await expect(bobDevice.client.send(conversation.id, { text: 'hi' })).rejects.toMatchObject({
      status: 403,
      code: 'BLOCKED',
    });
    await request(t.server)
      .delete(`/api/v1/blocks/${alice.ogcId}`)
      .set('Authorization', `Bearer ${bobDevice.token}`)
      .expect(204);
    // Withheld messages stay undelivered after unblocking.
    await bobDevice.client.syncConversation(conversation.id);
    expect(await textsOf(bobDevice, conversation.id)).not.toContain('Are you there?');
  });

  it('only lets contacts start conversations, and never with yourself', async () => {
    const malloryDevice = await newDevice(t, baseUrl, mallory, false);
    await expect(malloryDevice.transport.openConversation(alice.ogcId)).rejects.toMatchObject({
      status: 403,
      code: 'NOT_A_CONTACT',
    });
    await expect(malloryDevice.transport.openConversation('OGC999999990')).rejects.toMatchObject({
      status: 404,
    });
    await expect(malloryDevice.transport.openConversation(mallory.ogcId)).rejects.toMatchObject({
      status: 400,
    });
    // Opening twice returns the same conversation.
    const again = await aliceDevice.client.openDirect(bob.ogcId);
    expect(again.id).toBe(conversation.id);
  });

  it('recovers everything a device missed while offline, in order', async () => {
    const before = await bobDevice.transport.conversation(conversation.id);
    for (const text of ['one', 'two', 'three'])
      await aliceDevice.client.send(conversation.id, { text });
    // Paging through the change log in small pages yields every change exactly once, in order.
    const seen: number[] = [];
    let after = before.version;
    for (;;) {
      const page = await bobDevice.transport.sync(conversation.id, after, 2);
      seen.push(...page.items.map((i) => i.version));
      after = page.version;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);

    await bobDevice.client.syncAll();
    expect((await textsOf(bobDevice, conversation.id)).slice(-3)).toEqual(['one', 'two', 'three']);
    const history = await bobDevice.transport.history(conversation.id, { limit: 2 });
    expect(history.items.map((m: MessageView) => m.seq)).toEqual(
      [...history.items.map((m: MessageView) => m.seq)].sort((a, b) => a - b),
    );
    expect(history.hasMore).toBe(true);
  });

  it('queues messages while offline and sends them once on reconnection', async () => {
    const original = aliceDevice.transport.sendMessage;
    aliceDevice.transport.sendMessage = () => Promise.reject(new TransportError('offline', 0));
    await expect(
      aliceDevice.client.send(conversation.id, { text: 'sent from a tunnel' }),
    ).rejects.toThrow('offline');
    const pending = (await aliceDevice.client.messages(conversation.id)).at(-1);
    expect(pending).toMatchObject({ state: 'pending', payload: { text: 'sent from a tunnel' } });
    aliceDevice.transport.sendMessage = original;

    expect(await aliceDevice.client.flushOutbox()).toBe(1);
    expect(await aliceDevice.client.flushOutbox()).toBe(0);
    await bobDevice.client.syncConversation(conversation.id);
    expect((await textsOf(bobDevice, conversation.id)).at(-1)).toBe('sent from a tunnel');
  });

  it('computes the same safety number on both sides', async () => {
    const forAlice = await aliceDevice.client.safetyNumber(conversation.id);
    const forBob = await bobDevice.client.safetyNumber(conversation.id);
    expect(forAlice).toHaveLength(12);
    expect(forAlice).toEqual(forBob);
  });

  it('searches only the device’s own decrypted messages', async () => {
    const hits = await bobDevice.client.search('NORTH gate');
    expect(hits.map((m) => m.payload?.text)).toEqual([SECRET]);
    expect(await bobDevice.client.search('x')).toEqual([]);
  });

  // Last in this file: it adds messages to the shared conversation.
  it('rejects ciphertext a malicious server altered, and keeps working afterwards', async () => {
    await aliceDevice.client.send(conversation.id, { text: 'transfer 10 to Bob' });
    // The server flips one bit of the stored message before Bob fetches it.
    const stored = await t.prisma.message.findFirstOrThrow({
      where: { conversationId: conversation.id },
      orderBy: { seq: 'desc' },
    });
    const tampered = Buffer.from(stored.ciphertext ?? new Uint8Array());
    const middle = Math.floor(tampered.length / 2);
    tampered[middle] = (tampered[middle] ?? 0) ^ 0x01;
    await t.prisma.message.update({ where: { id: stored.id }, data: { ciphertext: tampered } });

    await bobDevice.client.syncConversation(conversation.id);
    const forged = (await bobDevice.client.messages(conversation.id)).find(
      (m) => m.id === stored.id,
    );
    // Shown as undecryptable, never as altered text.
    expect(forged).toMatchObject({ state: 'undecryptable', payload: null });
    expect(await textsOf(bobDevice, conversation.id)).not.toContain('transfer 10 to Bob');

    // The failed message does not break the conversation: the next one arrives intact.
    await aliceDevice.client.send(conversation.id, { text: 'genuine follow-up' });
    await bobDevice.client.syncConversation(conversation.id);
    expect((await textsOf(bobDevice, conversation.id)).at(-1)).toBe('genuine follow-up');
  });
});
