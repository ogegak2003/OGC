import type {
  ConversationView,
  GroupMemberView,
  ReceivedInvitationView,
  SentInvitationView,
} from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/**
 * Groups through direct API calls: the permission matrix
 * (docs/architecture/community-permissions.md) is enforced by the server no
 * matter what a client shows. Non-members always get the same 404.
 */
describe('groups: membership, roles and permissions', () => {
  let t: TestApp;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;

  const api = () => request(t.server);

  async function createGroup(by: TestUser, invite: TestUser[] = [], kind = 'GROUP') {
    const res = await by
      .as(api().post('/api/v1/groups'))
      .send({ kind, name: 'Book club', invite: invite.map((u) => u.ogcId) })
      .expect(201);
    return (res.body as { conversation: ConversationView }).conversation.id;
  }

  async function accept(user: TestUser, conversationId: string) {
    const list = await user.as(api().get('/api/v1/invitations')).expect(200);
    const invitation = (list.body as ReceivedInvitationView[]).find(
      (i) => i.conversationId === conversationId,
    );
    expect(invitation).toBeDefined();
    const res = await user.as(api().post(`/api/v1/invitations/${invitation?.id ?? ''}/accept`));
    return res.status;
  }

  async function roleOf(user: TestUser, conversationId: string) {
    const res = await owner.as(api().get(`/api/v1/groups/${conversationId}/members`)).expect(200);
    return (res.body as GroupMemberView[]).find((m) => m.profile.ogcId === user.ogcId)?.role;
  }

  beforeAll(async () => {
    t = await createTestApp();
    // Listening once lets supertest reuse the server for concurrent requests.
    await listen(t);
    [owner, admin, member, outsider] = await Promise.all([
      signedInUser(t, 'Owner'),
      signedInUser(t, 'Admin'),
      signedInUser(t, 'Member'),
      signedInUser(t, 'Outsider'),
    ]);
    await makeContacts(t, owner, admin);
    await makeContacts(t, owner, member);
    groupId = await createGroup(owner, [admin, member]);
    expect(await accept(admin, groupId)).toBe(200);
    expect(await accept(member, groupId)).toBe(200);
    await owner
      .as(api().put(`/api/v1/groups/${groupId}/members/${admin.ogcId}/role`))
      .send({ role: 'ADMIN' })
      .expect(204);
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('validates input and normalises names', async () => {
    await owner.as(api().post('/api/v1/groups')).send({ name: '   ' }).expect(400);
    await owner
      .as(api().post('/api/v1/groups'))
      .send({ name: 'x'.repeat(65) })
      .expect(400);
    await owner.as(api().post('/api/v1/groups')).send({ name: 'Bad‮name' }).expect(400);
    await owner.as(api().post('/api/v1/groups')).send({ name: 'Ok', extra: 1 }).expect(400);
    const res = await owner
      .as(api().post('/api/v1/groups'))
      .send({ name: '  Weekend   hikers ' })
      .expect(201);
    expect((res.body as { conversation: ConversationView }).conversation.group?.name).toBe(
      'Weekend hikers',
    );
  });

  it('hides groups from non-members behind identical 404s', async () => {
    // Built lazily: each supertest request starts its own ephemeral server.
    const probes = [
      () => api().get(`/api/v1/conversations/${groupId}`),
      () => api().get(`/api/v1/groups/${groupId}/members`),
      () => api().patch(`/api/v1/groups/${groupId}`).send({ name: 'x' }),
      () =>
        api()
          .post(`/api/v1/groups/${groupId}/invitations`)
          .send({ ogcIds: [member.ogcId] }),
      () => api().post(`/api/v1/groups/${groupId}/invite-links`).send({}),
      () => api().get(`/api/v1/groups/${groupId}/avatar`),
      () => api().get(`/api/v1/conversations/${groupId}/sync`),
      () => api().get(`/api/v1/conversations/${groupId}/devices`),
      () => api().delete(`/api/v1/groups/${groupId}`),
    ];
    for (const probe of probes) {
      const res = await outsider.as(probe()).expect(404);
      expect((res.body as { message: string }).message).toBe('Conversation not found');
    }
    const unknown = await outsider
      .as(api().get(`/api/v1/conversations/${crypto.randomUUID()}`))
      .expect(404);
    expect(unknown.body).toMatchObject({ message: 'Conversation not found' });
  });

  it('lists members with roles, owner first', async () => {
    const res = await member.as(api().get(`/api/v1/groups/${groupId}/members`)).expect(200);
    const members = res.body as GroupMemberView[];
    expect(members.map((m) => m.role)).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
    expect(JSON.stringify(members)).not.toMatch(/userId|email/);
  });

  it('enforces who may edit details and policies', async () => {
    await member
      .as(api().patch(`/api/v1/groups/${groupId}`))
      .send({ name: 'Mine now' })
      .expect(403);
    await member
      .as(api().patch(`/api/v1/groups/${groupId}`))
      .send({ invitePolicy: 'ALL_MEMBERS' })
      .expect(403);
    const res = await admin
      .as(api().patch(`/api/v1/groups/${groupId}`))
      .send({ description: 'Monthly reads' })
      .expect(200);
    expect((res.body as ConversationView).group?.description).toBe('Monthly reads');
  });

  it('only lets authorised members invite, and only their contacts', async () => {
    // Default invite policy: administrators.
    await makeContacts(t, member, outsider);
    await member
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [outsider.ogcId] })
      .expect(403);
    // An admin inviting a non-contact: skipped silently.
    const skipped = await admin
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [outsider.ogcId] })
      .expect(201);
    expect(skipped.body).toEqual({ invited: [] });
    await owner
      .as(api().patch(`/api/v1/groups/${groupId}`))
      .send({ invitePolicy: 'ALL_MEMBERS' })
      .expect(200);
    const invited = await member
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [outsider.ogcId] })
      .expect(201);
    expect(invited.body).toEqual({ invited: [outsider.ogcId] });
    // Inviting again is idempotent (one pending invitation per person).
    await member
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [outsider.ogcId] })
      .expect(201);
    expect(
      await t.prisma.conversationInvitation.count({
        where: { conversationId: groupId, inviteeId: outsider.userId, status: 'PENDING' },
      }),
    ).toBe(1);
    const sent = await owner.as(api().get(`/api/v1/groups/${groupId}/invitations`)).expect(200);
    expect((sent.body as SentInvitationView[])[0]).toMatchObject({ status: 'PENDING' });
  });

  it('lets only the invitee respond and the inviter or admins revoke', async () => {
    const list = await outsider.as(api().get('/api/v1/invitations')).expect(200);
    const invitation = (list.body as ReceivedInvitationView[])[0];
    expect(invitation).toMatchObject({ name: 'Book club', kind: 'GROUP' });
    // Someone else cannot accept or decline it.
    await admin.as(api().post(`/api/v1/invitations/${invitation?.id ?? ''}/accept`)).expect(404);
    await admin.as(api().post(`/api/v1/invitations/${invitation?.id ?? ''}/decline`)).expect(404);
    // An unrelated account cannot revoke it.
    const stranger = await signedInUser(t);
    await stranger.as(api().delete(`/api/v1/invitations/${invitation?.id ?? ''}`)).expect(404);
    await admin.as(api().delete(`/api/v1/invitations/${invitation?.id ?? ''}`)).expect(204);
    await outsider.as(api().post(`/api/v1/invitations/${invitation?.id ?? ''}/accept`)).expect(404);
  });

  it('refuses expired invitations', async () => {
    await member
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [outsider.ogcId] })
      .expect(201);
    await t.prisma.conversationInvitation.updateMany({
      where: { conversationId: groupId, inviteeId: outsider.userId, status: 'PENDING' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const list = await outsider.as(api().get('/api/v1/invitations')).expect(200);
    expect(list.body).toEqual([]);
    const pending = await t.prisma.conversationInvitation.findFirstOrThrow({
      where: { conversationId: groupId, inviteeId: outsider.userId, status: 'PENDING' },
    });
    await outsider.as(api().post(`/api/v1/invitations/${pending.id}/accept`)).expect(404);
  });

  it('enforces the role matrix', async () => {
    // Members cannot assign roles; nobody changes their own role or makes an owner.
    await member
      .as(api().put(`/api/v1/groups/${groupId}/members/${member.ogcId}/role`))
      .send({ role: 'ADMIN' })
      .expect(403);
    await admin
      .as(api().put(`/api/v1/groups/${groupId}/members/${admin.ogcId}/role`))
      .send({ role: 'MEMBER' })
      .expect(403);
    await owner
      .as(api().put(`/api/v1/groups/${groupId}/members/${member.ogcId}/role`))
      .send({ role: 'OWNER' })
      .expect(400);
    // Admins cannot create admins; owners can.
    await admin
      .as(api().put(`/api/v1/groups/${groupId}/members/${member.ogcId}/role`))
      .send({ role: 'ADMIN' })
      .expect(403);
    // Moderator is a channel role, not a group role.
    await owner
      .as(api().put(`/api/v1/groups/${groupId}/members/${member.ogcId}/role`))
      .send({ role: 'MODERATOR' })
      .expect(403);
    // Admins cannot act on the owner.
    await admin.as(api().delete(`/api/v1/groups/${groupId}/members/${owner.ogcId}`)).expect(403);
    await member.as(api().delete(`/api/v1/groups/${groupId}/members/${admin.ogcId}`)).expect(403);
    expect(await roleOf(admin, groupId)).toBe('ADMIN');
    expect(await roleOf(member, groupId)).toBe('MEMBER');
  });

  it('keeps exactly one owner through transfers', async () => {
    await admin
      .as(api().post(`/api/v1/groups/${groupId}/transfer`))
      .send({ ogcId: member.ogcId })
      .expect(403);
    await owner.as(api().post(`/api/v1/groups/${groupId}/leave`)).expect(409);
    await owner
      .as(api().post(`/api/v1/groups/${groupId}/transfer`))
      .send({ ogcId: admin.ogcId })
      .expect(204);
    expect(await roleOf(admin, groupId)).toBe('OWNER');
    expect(await roleOf(owner, groupId)).toBe('ADMIN');
    const owners = await t.prisma.conversationParticipant.count({
      where: { conversationId: groupId, role: 'OWNER' },
    });
    expect(owners).toBe(1);
    // Transfer back for the remaining tests.
    await admin
      .as(api().post(`/api/v1/groups/${groupId}/transfer`))
      .send({ ogcId: owner.ogcId })
      .expect(204);
    const events = await t.prisma.conversationEvent.findMany({
      where: { conversationId: groupId, type: 'OWNERSHIP_TRANSFERRED' },
    });
    expect(events).toHaveLength(2);
  });

  it('lets admins remove members and members leave; records the history', async () => {
    const extra = await signedInUser(t, 'Extra');
    await makeContacts(t, owner, extra);
    await owner
      .as(api().post(`/api/v1/groups/${groupId}/invitations`))
      .send({ ogcIds: [extra.ogcId] })
      .expect(201);
    expect(await accept(extra, groupId)).toBe(200);
    await admin.as(api().delete(`/api/v1/groups/${groupId}/members/${extra.ogcId}`)).expect(204);
    await extra.as(api().get(`/api/v1/conversations/${groupId}`)).expect(404);
    const types = (
      await t.prisma.conversationEvent.findMany({
        where: { conversationId: groupId },
        orderBy: { version: 'asc' },
      })
    ).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['CREATED', 'MEMBER_JOINED', 'ROLE_CHANGED', 'MEMBER_REMOVED']),
    );
    const audit = await t.prisma.auditEvent.findFirst({
      where: { type: 'GROUP_MEMBER_REMOVED', userId: admin.userId },
    });
    expect(audit).not.toBeNull();
    const notice = await t.prisma.notification.findFirst({
      where: { userId: extra.userId, type: 'GROUP_MEMBER_REMOVED' },
    });
    expect(notice?.data).toMatchObject({ groupName: 'Book club' });
  });

  it('caps membership at 32 even when invitations are accepted concurrently', async () => {
    const capOwner = await signedInUser(t, 'Cap owner');
    const people = await Promise.all(Array.from({ length: 33 }, () => signedInUser(t)));
    const capGroup = await createGroup(capOwner);
    // Pending invitations straight in the database (each would need a contact otherwise).
    await t.prisma.conversationInvitation.createMany({
      data: people.map((p) => ({
        conversationId: capGroup,
        inviterId: capOwner.userId,
        inviteeId: p.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    const results = await Promise.all(people.map((p) => accept(p, capGroup)));
    expect(results.filter((s) => s === 200)).toHaveLength(31);
    expect(results.filter((s) => s === 409)).toHaveLength(2);
    expect(
      await t.prisma.conversationParticipant.count({ where: { conversationId: capGroup } }),
    ).toBe(32);
  }, 120_000);

  it('makes archived groups read-only and lets only the owner archive or delete', async () => {
    await admin.as(api().post(`/api/v1/groups/${groupId}/archive`)).expect(403);
    await owner.as(api().post(`/api/v1/groups/${groupId}/archive`)).expect(204);
    const view = await member.as(api().get(`/api/v1/conversations/${groupId}`)).expect(200);
    expect((view.body as ConversationView).group).toMatchObject({ archived: true, canPost: false });
    await admin
      .as(api().patch(`/api/v1/groups/${groupId}`))
      .send({ name: 'x' })
      .expect(403);
    await owner.as(api().post(`/api/v1/groups/${groupId}/unarchive`)).expect(204);
    await admin.as(api().delete(`/api/v1/groups/${groupId}`)).expect(403);
  });

  it('stores per-member notification preferences', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await member
      .as(api().put(`/api/v1/conversations/${groupId}/notifications`))
      .send({ level: 'MENTIONS', mutedUntil: until })
      .expect(200);
    expect(res.body).toEqual({ level: 'MENTIONS', mutedUntil: until });
    await member
      .as(api().put(`/api/v1/conversations/${groupId}/notifications`))
      .send({ level: 'LOUD' })
      .expect(400);
  });

  it('accepts reports with explicitly disclosed text only, and audits without it', async () => {
    await member
      .as(api().post(`/api/v1/conversations/${groupId}/reports`))
      .send({
        category: 'HARASSMENT',
        reportedOgcId: admin.ogcId,
        disclosedText: 'the exact words I was sent',
      })
      .expect(202);
    const report = await t.prisma.conversationReport.findFirstOrThrow({
      where: { reporterId: member.userId },
    });
    expect(report).toMatchObject({
      reportedUserId: admin.userId,
      disclosedText: 'the exact words I was sent',
    });
    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { type: 'CONVERSATION_REPORTED', userId: member.userId },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('exact words');
    await outsider
      .as(api().post(`/api/v1/conversations/${groupId}/reports`))
      .send({ category: 'SPAM' })
      .expect(404);
    // Staff only for the queue.
    await member.as(api().get('/api/v1/admin/conversation-reports')).expect(403);
  });

  it('defaults encrypted channels to admin-only posting', async () => {
    const channelId = await createGroup(owner, [member], 'CHANNEL');
    expect(await accept(member, channelId)).toBe(200);
    const view = await member.as(api().get(`/api/v1/conversations/${channelId}`)).expect(200);
    expect((view.body as ConversationView).group).toMatchObject({
      kind: 'CHANNEL',
      postPolicy: 'ADMINS',
      canPost: false,
    });
  });

  it('lets the owner delete the group with everything in it', async () => {
    const doomed = await createGroup(owner, [member]);
    expect(await accept(member, doomed)).toBe(200);
    await owner.as(api().delete(`/api/v1/groups/${doomed}`)).expect(204);
    await member.as(api().get(`/api/v1/conversations/${doomed}`)).expect(404);
    expect(await t.prisma.conversationEvent.count({ where: { conversationId: doomed } })).toBe(0);
    expect(
      await t.prisma.auditEvent.count({ where: { type: 'GROUP_DELETED', userId: owner.userId } }),
    ).toBe(1);
  });
});
