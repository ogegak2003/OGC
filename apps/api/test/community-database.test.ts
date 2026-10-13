import { randomUUID } from 'node:crypto';
import type { ConversationView, OgcId } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSocket, eventually, listen } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/**
 * Integrity rules enforced by PostgreSQL itself (migration
 * 20261013120000_groups_channels_community), so no code path — including
 * future ones — can violate them; plus realtime rules for groups.
 */
describe('community data integrity and realtime', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let groupId: string;
  let channelId: string;

  const api = () => request(t.server);

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob, carol] = await Promise.all([
      signedInUser(t, 'Alice'),
      signedInUser(t, 'Bob'),
      signedInUser(t, 'Carol'),
    ]);
    await makeContacts(t, alice, bob);
    await makeContacts(t, alice, carol);
    await makeContacts(t, bob, carol);
    const group = await alice
      .as(api().post('/api/v1/groups'))
      .send({ name: 'Integrity', invite: [bob.ogcId, carol.ogcId] })
      .expect(201);
    groupId = (group.body as { conversation: ConversationView }).conversation.id;
    for (const user of [bob, carol]) {
      const invitation = await t.prisma.conversationInvitation.findFirstOrThrow({
        where: { conversationId: groupId, inviteeId: user.userId },
      });
      await user.as(api().post(`/api/v1/invitations/${invitation.id}/accept`)).expect(200);
    }
    const channel = await alice
      .as(api().post('/api/v1/channels'))
      .send({ handle: `integrity${String(Date.now()).slice(-6)}`, name: 'Integrity' })
      .expect(201);
    channelId = (channel.body as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  const rejects = (promise: Promise<unknown>) => expect(promise).rejects.toThrow();

  it('allows exactly one owner per group and channel', async () => {
    await rejects(
      t.prisma.conversationParticipant.update({
        where: { conversationId_userId: { conversationId: groupId, userId: bob.userId } },
        data: { role: 'OWNER' },
      }),
    );
    await rejects(
      t.prisma.channelMember.create({
        data: { channelId, userId: bob.userId, role: 'OWNER', status: 'ACTIVE' },
      }),
    );
  });

  it('allows one pending invitation per person and group, never to oneself', async () => {
    const data = {
      conversationId: groupId,
      inviterId: alice.userId,
      inviteeId: randomUUID(),
      expiresAt: new Date(Date.now() + 1000),
    };
    await rejects(t.prisma.conversationInvitation.create({ data })); // unknown invitee (FK)
    const dave = await signedInUser(t);
    const valid = { ...data, inviteeId: dave.userId };
    await t.prisma.conversationInvitation.create({ data: valid });
    await rejects(t.prisma.conversationInvitation.create({ data: valid }));
    await rejects(
      t.prisma.conversationInvitation.create({
        data: { ...valid, inviterId: dave.userId },
      }),
    );
    await rejects(
      t.prisma.conversationInvitation.create({
        data: { ...valid, inviteeId: alice.userId, inviterId: alice.userId },
      }),
    );
    await rejects(
      t.prisma.conversationInvitation.create({
        data: { ...valid, inviteeId: carol.userId, status: 'ACCEPTED' },
      }),
    );
  });

  it('requires invitation links to target exactly one thing and store only a hash', async () => {
    const base = { tokenHash: 'a'.repeat(64), createdById: alice.userId };
    await rejects(t.prisma.inviteLink.create({ data: base }));
    await rejects(
      t.prisma.inviteLink.create({ data: { ...base, conversationId: groupId, channelId } }),
    );
    await rejects(
      t.prisma.inviteLink.create({
        data: { ...base, tokenHash: 'ogc_inv_plaintext'.padEnd(64, 'x'), conversationId: groupId },
      }),
    );
    await rejects(
      t.prisma.inviteLink.create({
        data: { ...base, conversationId: groupId, maxUses: 1, useCount: 2 },
      }),
    );
  });

  it('checks channel handles, counters, reactions and post shape', async () => {
    await rejects(
      t.prisma.channel.create({
        data: { id: randomUUID(), handle: 'Bad Handle', name: 'x' },
      }),
    );
    await rejects(t.prisma.channel.update({ where: { id: channelId }, data: { memberCount: -1 } }));
    await rejects(
      t.prisma.channelMember.create({
        data: { channelId, userId: carol.userId, role: 'ADMIN', status: 'BANNED' },
      }),
    );
    const post = await t.prisma.channelPost.create({
      data: {
        channelId,
        seq: 1_000_000,
        version: 1_000_000,
        authorId: alice.userId,
        clientPostId: randomUUID(),
        body: 'x',
      },
    });
    await rejects(
      t.prisma.channelPostReaction.create({
        data: { postId: post.id, userId: alice.userId, reaction: 'skull' },
      }),
    );
    await rejects(
      t.prisma.channelPost.update({ where: { id: post.id }, data: { deletedAt: new Date() } }),
    );
    await rejects(
      t.prisma.channelPost.update({ where: { id: post.id }, data: { replyToId: post.id } }),
    );
    await rejects(
      t.prisma.channelAttachment.create({
        data: {
          id: randomUUID(),
          channelId,
          kind: 'FILE',
          name: 'x',
          mime: 'text/plain',
          size: 1,
          storageKey: '../../etc/passwd',
        },
      }),
    );
    await t.prisma.channelPost.delete({ where: { id: post.id } });
  });

  it('streams group membership changes and typing to members, never across a block', async () => {
    const bobLive = connectSocket(baseUrl, { token: bob.accessToken });
    const carolLive = connectSocket(baseUrl, { token: carol.accessToken });
    await Promise.all([bobLive.connected, carolLive.connected]);

    // Carol blocks Bob: she stops seeing his typing in the group (and he hers).
    await carol.as(api().post(`/api/v1/blocks/${bob.ogcId}`)).expect(204);
    const aliceLive = connectSocket(baseUrl, { token: alice.accessToken });
    await aliceLive.connected;
    bobLive.socket.emit('typing.start', { conversationId: groupId });
    await eventually(() => aliceLive.events.some((e) => e.event === 'message.typing'), Boolean);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(carolLive.events.some((e) => e.event === 'message.typing')).toBe(false);

    // Presence is not shared just because people share a group (no DIRECT conversation).
    const presence = await new Promise<unknown>((resolve) => {
      carolLive.socket.emit('presence.subscribe', { ogcIds: [alice.ogcId as OgcId] }, resolve);
    });
    expect(presence).toEqual({ ok: true, data: [] });

    // Removal reaches the removed person's devices and the remaining members.
    await alice.as(api().delete(`/api/v1/groups/${groupId}/members/${carol.ogcId}`)).expect(204);
    await eventually(
      () => carolLive.events.find((e) => e.event === 'group.member_removed'),
      Boolean,
    );
    await eventually(() => bobLive.events.some((e) => e.event === 'devices.changed'), Boolean);
    for (const live of [aliceLive, bobLive, carolLive]) live.socket.disconnect();
  });
});
