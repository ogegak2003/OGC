import type { BlockView, Page, PublicProfile, UserReportView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

describe('blocking', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const block = (by: TestUser, ogcId: string) =>
    by.as(request(t.server).post(`/api/v1/blocks/${ogcId}`));
  const unblock = (by: TestUser, ogcId: string) =>
    by.as(request(t.server).delete(`/api/v1/blocks/${ogcId}`));
  const sendRequest = (from: TestUser, ogcId: string) =>
    from.as(request(t.server).post('/api/v1/contacts/requests')).send({ ogcId });

  it('blocks and lists blocked users without exposing their photo', async () => {
    const me = await signedInUser(t);
    const pest = await signedInUser(t, 'Pest');
    await block(me, pest.ogcId).expect(204);
    const list = (await me.as(request(t.server).get('/api/v1/blocks')).expect(200))
      .body as Page<BlockView>;
    expect(list.items).toEqual([
      {
        profile: { ogcId: pest.ogcId, displayName: 'Pest', avatarUrl: null },
        blockedAt: expect.any(String) as string,
      },
    ]);
    const audit = await t.prisma.auditEvent.count({
      where: { userId: me.userId, type: 'USER_BLOCKED' },
    });
    expect(audit).toBe(1);
  });

  it('is idempotent: blocking twice keeps one block', async () => {
    const me = await signedInUser(t);
    const pest = await signedInUser(t);
    await block(me, pest.ogcId).expect(204);
    await block(me, pest.ogcId).expect(204);
    expect(await t.prisma.block.count({ where: { blockerId: me.userId } })).toBe(1);
  });

  it('removes an existing contact and cancels pending requests in both directions', async () => {
    const me = await signedInUser(t);
    const friend = await signedInUser(t);
    const requester = await signedInUser(t);
    await makeContacts(t, me, friend);
    await sendRequest(requester, me.ogcId).expect(201);

    await block(me, friend.ogcId).expect(204);
    await block(me, requester.ogcId).expect(204);

    expect(
      await t.prisma.contact.count({ where: { ownerId: { in: [me.userId, friend.userId] } } }),
    ).toBe(0);
    expect(
      await t.prisma.contactRequest.count({
        where: { senderId: requester.userId, status: 'PENDING' },
      }),
    ).toBe(0);
  });

  it('prevents contact requests in both directions, without revealing the block', async () => {
    const blocker = await signedInUser(t);
    const blocked = await signedInUser(t);
    await block(blocker, blocked.ogcId).expect(204);

    // The blocked person sees the same answer as for a nonexistent account.
    const attempt = await sendRequest(blocked, blocker.ogcId);
    const unknown = await sendRequest(blocked, 'OGC999999995');
    expect(attempt.status).toBe(404);
    expect({ ...attempt.body, requestId: null }).toEqual({ ...unknown.body, requestId: null });
    // The blocker is told to unblock first.
    expect((await sendRequest(blocker, blocked.ogcId)).status).toBe(409);
  });

  it('prevents a blocked user from accepting an old request (bypass attempt)', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    await sendRequest(alice, bob.ogcId).expect(201);
    const id = (
      (await bob.as(request(t.server).get('/api/v1/contacts/requests/incoming')).expect(200))
        .body as Page<{ id: string }>
    ).items[0]?.id;
    await block(alice, bob.ogcId).expect(204);
    await bob
      .as(request(t.server).post(`/api/v1/contacts/requests/${id ?? ''}/accept`))
      .expect(404);
    expect(await t.prisma.contact.count({ where: { ownerId: bob.userId } })).toBe(0);
  });

  it('unblocks without restoring the former contact', async () => {
    const me = await signedInUser(t);
    const friend = await signedInUser(t);
    await makeContacts(t, me, friend);
    await block(me, friend.ogcId).expect(204);
    await unblock(me, friend.ogcId).expect(204);
    await unblock(me, friend.ogcId).expect(204);
    const profile = (
      await me.as(request(t.server).get(`/api/v1/profiles/${friend.ogcId}`)).expect(200)
    ).body as PublicProfile;
    expect(profile.relationship).toBe('NONE');
    expect((await friend.as(request(t.server).get(`/api/v1/profiles/${me.ogcId}`))).status).toBe(
      200,
    );
  });

  it('answers unknown OGC IDs exactly like known ones (no enumeration)', async () => {
    const me = await signedInUser(t);
    await block(me, 'OGC999999994').expect(204);
    await unblock(me, 'OGC999999994').expect(204);
    expect(await t.prisma.block.count({ where: { blockerId: me.userId } })).toBe(0);
  });

  it('rejects blocking oneself and malformed IDs', async () => {
    const me = await signedInUser(t);
    expect((await block(me, me.ogcId)).status).toBe(400);
    expect((await block(me, 'OGC12')).status).toBe(400);
    await request(t.server).post(`/api/v1/blocks/${me.ogcId}`).expect(401);
  });
});

describe('reporting', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const report = (from: TestUser, body: Record<string, unknown>) =>
    from.as(request(t.server).post('/api/v1/reports/users')).send(body);

  it('stores a valid report for moderators', async () => {
    const reporter = await signedInUser(t);
    const target = await signedInUser(t);
    const res = await report(reporter, {
      ogcId: target.ogcId,
      category: 'HARASSMENT',
      description: 'Sent threatening messages.',
    }).expect(202);
    expect(res.body).toEqual({ received: true });
    const stored = await t.prisma.userReport.findFirstOrThrow({
      where: { reporterId: reporter.userId },
    });
    expect(stored).toMatchObject({
      reportedUserId: target.userId,
      category: 'HARASSMENT',
      status: 'OPEN',
      description: 'Sent threatening messages.',
    });
  });

  it('accepts a report about someone who blocked the reporter', async () => {
    const victim = await signedInUser(t);
    const harasser = await signedInUser(t);
    await harasser.as(request(t.server).post(`/api/v1/blocks/${victim.ogcId}`)).expect(204);
    await report(victim, { ogcId: harasser.ogcId, category: 'HARASSMENT' }).expect(202);
    expect(await t.prisma.userReport.count({ where: { reportedUserId: harasser.userId } })).toBe(1);
  });

  it('treats duplicate open reports and unknown IDs as no-ops with the same answer', async () => {
    const reporter = await signedInUser(t);
    const target = await signedInUser(t);
    await report(reporter, { ogcId: target.ogcId, category: 'SPAM' }).expect(202);
    await report(reporter, { ogcId: target.ogcId, category: 'SPAM' }).expect(202);
    await report(reporter, { ogcId: 'OGC999999993', category: 'SPAM' }).expect(202);
    expect(await t.prisma.userReport.count({ where: { reporterId: reporter.userId } })).toBe(1);
  });

  it.each([
    ['unknown category', { category: 'BAN_THEM' }],
    ['moderation action', { category: 'SPAM', action: 'SUSPEND' }],
    ['status injection', { category: 'SPAM', status: 'RESOLVED' }],
    ['long description', { category: 'SPAM', description: 'x'.repeat(1001) }],
  ])('rejects %s', async (_label, extra) => {
    const reporter = await signedInUser(t);
    const target = await signedInUser(t);
    const res = await report(reporter, { ogcId: target.ogcId, ...extra });
    expect(res.status).toBe(400);
  });

  it('rejects self-reports', async () => {
    const me = await signedInUser(t);
    expect((await report(me, { ogcId: me.ogcId, category: 'SPAM' })).status).toBe(400);
  });

  it('limits reports per account', async () => {
    const reporter = await signedInUser(t);
    const categories = [
      'SPAM',
      'HARASSMENT',
      'IMPERSONATION',
      'INAPPROPRIATE_CONTENT',
      'SCAM_OR_FRAUD',
      'OTHER',
    ];
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await report(reporter, {
            ogcId: `OGC${String(200_000_000 + i)}`,
            category: categories[i % 6],
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('exposes reports only to staff, without internal identifiers', async () => {
    const reporter = await signedInUser(t);
    const target = await signedInUser(t);
    await report(reporter, { ogcId: target.ogcId, category: 'IMPERSONATION' }).expect(202);

    await request(t.server).get('/api/v1/admin/reports').expect(401);
    const user = await signedInUser(t);
    const denied = await user.as(request(t.server).get('/api/v1/admin/reports'));
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });

    const moderator = await signedInUser(t);
    await t.prisma.staffRoleAssignment.create({
      data: { userId: moderator.userId, role: 'MODERATOR' },
    });
    const res = await moderator
      .as(request(t.server).get('/api/v1/admin/reports?limit=100'))
      .expect(200);
    const page = res.body as Page<UserReportView>;
    expect(page.items).toContainEqual(
      expect.objectContaining({
        category: 'IMPERSONATION',
        reporterOgcId: reporter.ogcId,
        reportedOgcId: target.ogcId,
        status: 'OPEN',
      }),
    );
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(reporter.userId);
    expect(text).not.toContain(target.userId);
  });

  it('ignores role claims supplied by the client', async () => {
    const user = await signedInUser(t);
    const res = await user
      .as(request(t.server).get('/api/v1/admin/reports'))
      .set('X-OGC-Role', 'ADMIN')
      .set('X-Staff-Roles', 'MODERATOR');
    expect(res.status).toBe(403);
    // Unknown query parameters (e.g. ?role=ADMIN) are rejected outright.
    const query = await user.as(request(t.server).get('/api/v1/admin/reports?role=ADMIN'));
    expect([400, 403]).toContain(query.status);
  });
});
