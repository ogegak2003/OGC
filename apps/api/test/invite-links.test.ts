import { createHash } from 'node:crypto';
import type { ChannelView, ConversationView, CreatedInviteLink, InvitePreview } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from './support/messaging.js';
import { type TestApp, type TestUser, createTestApp, signedInUser } from './support/test-app.js';

process.env.RATE_LIMIT_INVITE_LINK_JOIN_PER_HOUR = '200';

/** Invitation links and QR codes (ADR-034): tokens, expiry, limits, revocation, policies. */
describe('invitation links', () => {
  let t: TestApp;
  let owner: TestUser;
  let member: TestUser;
  let guest: TestUser;
  let groupId: string;

  const api = () => request(t.server);

  async function createLink(path: string, body: Record<string, unknown> = {}) {
    const res = await owner
      .as(api().post(`${path}/invite-links`))
      .send(body)
      .expect(201);
    return res.body as CreatedInviteLink;
  }

  const join = (user: TestUser, token: string) =>
    user.as(api().post('/api/v1/invite-links/join')).send({ token });

  beforeAll(async () => {
    t = await createTestApp();
    // Listening once lets supertest reuse the server for concurrent requests.
    await listen(t);
    [owner, member, guest] = await Promise.all([
      signedInUser(t, 'Owner'),
      signedInUser(t, 'Member'),
      signedInUser(t, 'Guest'),
    ]);
    const res = await owner.as(api().post('/api/v1/groups')).send({ name: 'Choir' }).expect(201);
    groupId = (res.body as { conversation: ConversationView }).conversation.id;
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('creates 256-bit tokens and stores only their hash', async () => {
    const link = await createLink(`/api/v1/groups/${groupId}`, { expiresInHours: 24 });
    expect(link.token).toMatch(/^ogc_inv_[A-Za-z0-9_-]{43}$/);
    const row = await t.prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(createHash('sha256').update(link.token).digest('hex'));
    const everything = JSON.stringify(
      await t.prisma.$queryRaw`SELECT * FROM invite_links`,
      (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
    );
    expect(everything).not.toContain(link.token.slice(8));
    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { type: 'INVITE_LINK_CREATED', userId: owner.userId },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(link.token.slice(8));
    // Listing never returns tokens again.
    const list = await owner.as(api().get(`/api/v1/groups/${groupId}/invite-links`)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('ogc_inv_');
  });

  it('previews and joins, without consuming uses for existing members', async () => {
    const link = await createLink(`/api/v1/groups/${groupId}`, { maxUses: 5 });
    const preview = await member
      .as(api().post('/api/v1/invite-links/preview'))
      .send({ token: link.token })
      .expect(200);
    expect(preview.body as InvitePreview).toMatchObject({
      target: 'GROUP',
      id: groupId,
      name: 'Choir',
      memberCount: 1,
      alreadyMember: false,
      endToEndEncrypted: true,
      avatarUrl: null,
    });
    expect((await join(member, link.token)).status).toBe(200);
    expect((await join(member, link.token)).status).toBe(200);
    expect((await t.prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(
      1,
    );
  });

  it('answers identically for unknown, malformed, revoked, expired and used-up links', async () => {
    const revoked = await createLink(`/api/v1/groups/${groupId}`);
    await owner.as(api().delete(`/api/v1/invite-links/${revoked.id}`)).expect(204);
    const expired = await createLink(`/api/v1/groups/${groupId}`);
    await t.prisma.inviteLink.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const used = await createLink(`/api/v1/groups/${groupId}`, { maxUses: 1 });
    await t.prisma.inviteLink.update({ where: { id: used.id }, data: { useCount: 1 } });
    const unknown = `ogc_inv_${'A'.repeat(43)}`;
    const bodies: unknown[] = [];
    for (const token of [revoked.token, expired.token, used.token, unknown]) {
      const res = await guest
        .as(api().post('/api/v1/invite-links/preview'))
        .send({ token })
        .expect(404);
      bodies.push({
        code: (res.body as { code: string }).code,
        message: (res.body as { message: string }).message,
      });
      await join(guest, token).expect(404);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    await guest
      .as(api().post('/api/v1/invite-links/join'))
      .send({ token: 'not-a-token' })
      .expect(400);
    await guest.as(api().get(`/api/v1/conversations/${groupId}`)).expect(404);
  });

  it('admits at most maxUses people under concurrent joins', async () => {
    const link = await createLink(`/api/v1/groups/${groupId}`, { maxUses: 3 });
    const people = await Promise.all(Array.from({ length: 8 }, () => signedInUser(t)));
    const statuses = await Promise.all(people.map(async (p) => (await join(p, link.token)).status));
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 404)).toHaveLength(5);
    expect((await t.prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(
      3,
    );
  }, 60_000);

  it('only lets owners and administrators manage links', async () => {
    await member
      .as(api().post(`/api/v1/groups/${groupId}/invite-links`))
      .send({})
      .expect(403);
    await member.as(api().get(`/api/v1/groups/${groupId}/invite-links`)).expect(403);
    const link = await createLink(`/api/v1/groups/${groupId}`);
    await member.as(api().delete(`/api/v1/invite-links/${link.id}`)).expect(404);
    await guest
      .as(api().post(`/api/v1/groups/${groupId}/invite-links`))
      .send({})
      .expect(404);
    await owner
      .as(api().post(`/api/v1/groups/${groupId}/invite-links`))
      .send({ expiresInHours: 24 * 31 })
      .expect(400);
  });

  it('never bypasses channel bans or approval policies', async () => {
    const res = await owner
      .as(api().post('/api/v1/channels'))
      .send({
        handle: `linkchan${String(Date.now()).slice(-6)}`,
        name: 'Private club',
        visibility: 'PRIVATE',
        joinPolicy: 'APPROVAL',
      })
      .expect(201);
    const channel = res.body as ChannelView;
    const link = await createLink(`/api/v1/channels/${channel.id}`);
    const preview = await guest
      .as(api().post('/api/v1/invite-links/preview'))
      .send({ token: link.token })
      .expect(200);
    expect(preview.body as InvitePreview).toMatchObject({
      target: 'COMMUNITY_CHANNEL',
      requiresApproval: true,
      endToEndEncrypted: false,
    });
    const joined = await join(guest, link.token).expect(200);
    expect(joined.body).toMatchObject({ status: 'PENDING' });
    await guest.as(api().get(`/api/v1/channels/${channel.id}/posts`)).expect(404);

    await owner
      .as(api().post(`/api/v1/channels/${channel.id}/bans/${member.ogcId}`))
      .send({ reason: 'Not welcome' })
      .expect(204);
    await member
      .as(api().post('/api/v1/invite-links/preview'))
      .send({ token: link.token })
      .expect(404);
    await join(member, link.token).expect(403);
  });

  it('does not admit people to archived groups', async () => {
    const link = await createLink(`/api/v1/groups/${groupId}`);
    await owner.as(api().post(`/api/v1/groups/${groupId}/archive`)).expect(204);
    const late = await signedInUser(t);
    await late
      .as(api().post('/api/v1/invite-links/preview'))
      .send({ token: link.token })
      .expect(404);
    await join(late, link.token).expect(403);
    await owner.as(api().post(`/api/v1/groups/${groupId}/unarchive`)).expect(204);
  });
});
