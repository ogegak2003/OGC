import sharp from 'sharp';
import type {
  ChannelMemberView,
  ChannelPostPage,
  ChannelPostReportView,
  ChannelPostView,
  ChannelSyncPage,
  ChannelView,
  ModerationActionView,
  Page,
} from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSocket, eventually, listen } from './support/messaging.js';
import { type TestApp, type TestUser, createTestApp, signedInUser } from './support/test-app.js';

/**
 * Community channels (server-readable) through direct API calls: visibility,
 * join policies, posting policies, replies, announcements, pins, moderation,
 * reports, media and realtime fan-out.
 */
describe('community channels', () => {
  let t: TestApp;
  let baseUrl: string;
  let owner: TestUser;
  let moderator: TestUser;
  let member: TestUser;
  let reader: TestUser;
  let channel: ChannelView;

  const api = () => request(t.server);
  let handleCounter = 0;
  const handle = () => `chan${String(Date.now()).slice(-6)}${String(handleCounter++)}`;

  async function createChannel(by: TestUser, body: Record<string, unknown> = {}) {
    const res = await by
      .as(api().post('/api/v1/channels'))
      .send({ handle: handle(), name: 'Night Sky Watchers', ...body })
      .expect(201);
    return res.body as ChannelView;
  }

  async function post(by: TestUser, channelId: string, body: Record<string, unknown>) {
    return by
      .as(api().post(`/api/v1/channels/${channelId}/posts`))
      .send({ clientPostId: crypto.randomUUID(), ...body });
  }

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [owner, moderator, member, reader] = await Promise.all([
      signedInUser(t, 'Owner'),
      signedInUser(t, 'Moderator'),
      signedInUser(t, 'Member'),
      signedInUser(t, 'Reader'),
    ]);
    channel = await createChannel(owner, {
      description: 'Astronomy for everyone',
      postPolicy: 'ADMINS',
    });
    for (const user of [moderator, member]) {
      await user.as(api().post(`/api/v1/channels/${channel.id}/join`)).expect(201);
    }
    await owner
      .as(api().put(`/api/v1/channels/${channel.id}/members/${moderator.ogcId}/role`))
      .send({ role: 'MODERATOR' })
      .expect(204);
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('is clearly labelled as not end-to-end encrypted', () => {
    expect(channel).toMatchObject({
      endToEndEncrypted: false,
      visibility: 'PUBLIC',
      membership: { role: 'OWNER', status: 'ACTIVE' },
      canPost: true,
      memberCount: 1,
    });
  });

  it('validates handles and keeps them unique', async () => {
    await owner.as(api().post('/api/v1/channels')).send({ handle: '1abc', name: 'x' }).expect(400);
    await owner.as(api().post('/api/v1/channels')).send({ handle: 'ab', name: 'x' }).expect(400);
    const res = await owner
      .as(api().post('/api/v1/channels'))
      .send({ handle: channel.handle.toUpperCase(), name: 'Copy' })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('HANDLE_TAKEN');
  });

  it('lists only public channels in discovery and search', async () => {
    const secret = await createChannel(owner, { name: 'Secret Night Sky', visibility: 'PRIVATE' });
    const found = await reader.as(api().get('/api/v1/channels/discover?q=night%20sky')).expect(200);
    const ids = (found.body as Page<ChannelView>).items.map((c) => c.id);
    expect(ids).toContain(channel.id);
    expect(ids).not.toContain(secret.id);
    // Private channels are invisible to non-members by any route.
    await reader.as(api().get(`/api/v1/channels/${secret.id}`)).expect(404);
    await reader.as(api().get(`/api/v1/channels/by-handle/${secret.handle}`)).expect(404);
    await reader.as(api().get(`/api/v1/channels/${secret.id}/posts`)).expect(404);
    await reader.as(api().post(`/api/v1/channels/${secret.id}/join`)).expect(404);
    // LIKE wildcards in queries are literal.
    const wild = await reader.as(api().get('/api/v1/channels/discover?q=%25%25')).expect(200);
    expect((wild.body as Page<ChannelView>).items).toEqual([]);
  });

  it('enforces the post policy, replies and announcements', async () => {
    const first = await post(owner, channel.id, {
      body: 'Perseids peak tonight',
      announcement: true,
    });
    expect(first.status).toBe(201);
    const top = first.body as ChannelPostView;
    expect(top).toMatchObject({ announcement: true, seq: expect.any(Number) as number });

    // Members cannot write top-level posts under ADMINS, but can reply.
    expect((await post(member, channel.id, { body: 'Me too' })).status).toBe(403);
    const reply = await post(member, channel.id, { body: 'Clear skies here', replyToId: top.id });
    expect(reply.status).toBe(201);
    // Replies to replies are refused; announcements are for admins.
    expect(
      (await post(member, channel.id, { body: 'x', replyToId: (reply.body as ChannelPostView).id }))
        .status,
    ).toBe(400);
    expect((await post(moderator, channel.id, { body: 'x', announcement: true })).status).toBe(403);
    // Non-members cannot post at all; readers of public channels can read.
    expect((await post(reader, channel.id, { body: 'hi', replyToId: top.id })).status).toBe(403);
    const feed = await reader.as(api().get(`/api/v1/channels/${channel.id}/posts`)).expect(200);
    expect((feed.body as ChannelPostPage).items[0]).toMatchObject({ id: top.id, replyCount: 1 });
    const thread = await reader.as(api().get(`/api/v1/channel-posts/${top.id}/thread`)).expect(200);
    expect((thread.body as { replies: ChannelPostPage }).replies.items.map((p) => p.body)).toEqual([
      'Clear skies here',
    ]);

    // Announcements notify members (once, deduplicated).
    const notices = await t.prisma.notification.findMany({
      where: { userId: member.userId, type: 'CHANNEL_ANNOUNCEMENT' },
    });
    expect(notices).toHaveLength(1);

    // Turning replies off closes discussion.
    await owner
      .as(api().patch(`/api/v1/channels/${channel.id}`))
      .send({ repliesEnabled: false })
      .expect(200);
    expect((await post(member, channel.id, { body: 'late', replyToId: top.id })).status).toBe(403);
    await owner
      .as(api().patch(`/api/v1/channels/${channel.id}`))
      .send({ repliesEnabled: true })
      .expect(200);
    // Only admins change settings.
    await moderator
      .as(api().patch(`/api/v1/channels/${channel.id}`))
      .send({ postPolicy: 'ALL_MEMBERS' })
      .expect(403);
  });

  it('makes posting idempotent per client post ID', async () => {
    const clientPostId = crypto.randomUUID();
    const a = await post(owner, channel.id, { body: 'Once', clientPostId });
    const b = await post(owner, channel.id, { body: 'Once', clientPostId });
    expect((a.body as ChannelPostView).id).toBe((b.body as ChannelPostView).id);
  });

  it('lets authors edit and delete, and syncs changes in order', async () => {
    const created = (await post(owner, channel.id, { body: 'Typo' })).body as ChannelPostView;
    await member
      .as(api().patch(`/api/v1/channel-posts/${created.id}`))
      .send({ body: 'x' })
      .expect(403);
    const edited = await owner
      .as(api().patch(`/api/v1/channel-posts/${created.id}`))
      .send({ body: 'Fixed' })
      .expect(200);
    expect((edited.body as ChannelPostView).editedAt).not.toBeNull();
    await owner.as(api().put(`/api/v1/channel-posts/${created.id}/reactions/heart`)).expect(204);
    await member.as(api().put(`/api/v1/channel-posts/${created.id}/reactions/heart`)).expect(204);
    await member.as(api().put(`/api/v1/channel-posts/${created.id}/reactions/fire`)).expect(400);
    const sync = await member
      .as(api().get(`/api/v1/channels/${channel.id}/sync?after=${String(created.version)}`))
      .expect(200);
    const changed = (sync.body as ChannelSyncPage).items.find((p) => p.id === created.id);
    expect(changed?.reactions).toEqual([{ reaction: 'heart', count: 2, mine: true }]);
    await owner.as(api().delete(`/api/v1/channel-posts/${created.id}`)).expect(204);
    const after = await member
      .as(api().get(`/api/v1/channels/${channel.id}/sync?after=0&limit=200`))
      .expect(200);
    const deleted = (after.body as ChannelSyncPage).items.find((p) => p.id === created.id);
    expect(deleted).toMatchObject({ body: null, reactions: [] });
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it('lets moderators pin, remove and restore posts with reasons', async () => {
    const target = (
      await post(member, channel.id, {
        body: 'Buy cheap telescopes at scam.example',
        replyToId: (
          (await post(owner, channel.id, { body: 'Gear thread' })).body as ChannelPostView
        ).id,
      })
    ).body as ChannelPostView;
    const pinned = (await post(owner, channel.id, { body: 'Rules' })).body as ChannelPostView;
    await member.as(api().put(`/api/v1/channel-posts/${pinned.id}/pin`)).expect(403);
    await moderator.as(api().put(`/api/v1/channel-posts/${pinned.id}/pin`)).expect(204);
    const pins = await reader.as(api().get(`/api/v1/channels/${channel.id}/pinned`)).expect(200);
    expect((pins.body as ChannelPostView[]).map((p) => p.id)).toEqual([pinned.id]);

    await member
      .as(api().post(`/api/v1/channel-posts/${target.id}/remove`))
      .send({})
      .expect(403);
    await moderator
      .as(api().post(`/api/v1/channel-posts/${target.id}/remove`))
      .send({ reason: 'Spam link' })
      .expect(204);
    const asMember = await member
      .as(api().get(`/api/v1/channel-posts/${target.replyToId ?? ''}/thread`))
      .expect(200);
    const hidden = (asMember.body as { replies: ChannelPostPage }).replies.items[0];
    expect(hidden).toMatchObject({ removed: true, body: null });
    expect(hidden?.removedBody).toBeUndefined();
    const asModerator = await moderator
      .as(api().get(`/api/v1/channel-posts/${target.replyToId ?? ''}/thread`))
      .expect(200);
    expect(
      (asModerator.body as { replies: ChannelPostPage }).replies.items[0]?.removedBody,
    ).toContain('scam.example');
    // Moderators cannot moderate posts of administrators or the owner.
    await moderator
      .as(api().post(`/api/v1/channel-posts/${pinned.id}/remove`))
      .send({ reason: 'x' })
      .expect(403);
    await moderator
      .as(api().post(`/api/v1/channel-posts/${target.id}/restore`))
      .send({ reason: 'Appeal accepted' })
      .expect(204);
    const history = await moderator
      .as(api().get(`/api/v1/channels/${channel.id}/moderation`))
      .expect(200);
    const actions = (history.body as Page<ModerationActionView>).items.map((a) => [
      a.action,
      a.reason,
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['REMOVE_POST', 'Spam link'],
        ['RESTORE_POST', 'Appeal accepted'],
        ['PIN_POST', null],
      ]),
    );
    await member.as(api().get(`/api/v1/channels/${channel.id}/moderation`)).expect(403);
  });

  it('suspends, removes and bans with the role hierarchy enforced', async () => {
    const top = (await post(owner, channel.id, { body: 'Discussion' })).body as ChannelPostView;
    // Moderators cannot act on the owner or other moderators.
    await moderator
      .as(api().post(`/api/v1/channels/${channel.id}/members/${owner.ogcId}/suspend`))
      .send({ hours: 1 })
      .expect(403);
    await moderator
      .as(api().post(`/api/v1/channels/${channel.id}/members/${member.ogcId}/suspend`))
      .send({ hours: 2, reason: 'Cool down' })
      .expect(204);
    const suspended = await post(member, channel.id, { body: 'hello?', replyToId: top.id });
    expect(suspended.status).toBe(403);
    expect((suspended.body as { code: string }).code).toBe('SUSPENDED');
    await member.as(api().put(`/api/v1/channel-posts/${top.id}/reactions/joy`)).expect(403);
    await moderator
      .as(api().delete(`/api/v1/channels/${channel.id}/members/${member.ogcId}/suspend`))
      .expect(204);
    expect((await post(member, channel.id, { body: 'back', replyToId: top.id })).status).toBe(201);

    // Ban: access ends (even to a public channel's posts), rejoining is refused.
    await moderator
      .as(api().post(`/api/v1/channels/${channel.id}/bans/${member.ogcId}`))
      .send({ reason: 'Repeated spam' })
      .expect(204);
    await member.as(api().post(`/api/v1/channels/${channel.id}/join`)).expect(403);
    expect((await post(member, channel.id, { body: 'x', replyToId: top.id })).status).toBe(404);
    await member.as(api().get(`/api/v1/channels/${channel.id}/posts`)).expect(404);
    const members = await moderator
      .as(api().get(`/api/v1/channels/${channel.id}/members?status=BANNED`))
      .expect(200);
    expect((members.body as Page<ChannelMemberView>).items.map((m) => m.profile.ogcId)).toEqual([
      member.ogcId,
    ]);
    // Regular members see only the channel's staff.
    await moderator
      .as(api().delete(`/api/v1/channels/${channel.id}/bans/${member.ogcId}`))
      .send({})
      .expect(204);
    await member.as(api().post(`/api/v1/channels/${channel.id}/join`)).expect(201);
    const directory = await member
      .as(api().get(`/api/v1/channels/${channel.id}/members`))
      .expect(200);
    expect((directory.body as Page<ChannelMemberView>).items.map((m) => m.role).sort()).toEqual([
      'MODERATOR',
      'OWNER',
    ]);
  });

  it('routes reports to channel moderators and tells the reporter the outcome', async () => {
    const offending = (await post(owner, channel.id, { body: 'Original' })).body as ChannelPostView;
    const reply = (await post(member, channel.id, { body: 'Rude words', replyToId: offending.id }))
      .body as ChannelPostView;
    await reader
      .as(api().post(`/api/v1/channel-posts/${reply.id}/reports`))
      .send({ category: 'HARASSMENT', description: 'Insulting' })
      .expect(202);
    await member
      .as(api().post(`/api/v1/channel-posts/${reply.id}/reports`))
      .send({ category: 'SPAM' })
      .expect(403);
    const queue = await moderator
      .as(api().get(`/api/v1/channels/${channel.id}/reports`))
      .expect(200);
    const report = (queue.body as Page<ChannelPostReportView>).items[0];
    expect(report).toMatchObject({ category: 'HARASSMENT', post: { id: reply.id } });
    await member.as(api().get(`/api/v1/channels/${channel.id}/reports`)).expect(403);
    await moderator
      .as(api().post(`/api/v1/channel-reports/${report?.id ?? ''}/resolve`))
      .send({ outcome: 'RESOLVED', resolution: 'Removed', removePost: true })
      .expect(204);
    const removed = await t.prisma.channelPost.findUniqueOrThrow({ where: { id: reply.id } });
    expect(removed.removedAt).not.toBeNull();
    const outcome = await t.prisma.notification.findFirst({
      where: { userId: reader.userId, type: 'MODERATION_RESULT' },
    });
    expect(outcome?.data).toMatchObject({ outcome: 'RESOLVED' });
  });

  it('requires approval when the join policy says so', async () => {
    const club = await createChannel(owner, { joinPolicy: 'APPROVAL' });
    const res = await reader.as(api().post(`/api/v1/channels/${club.id}/join`)).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING' });
    expect((await post(reader, club.id, { body: 'x' })).status).toBe(403);
    const request_ = await t.prisma.notification.findFirst({
      where: { userId: owner.userId, type: 'CHANNEL_JOIN_REQUEST' },
    });
    expect(request_).not.toBeNull();
    await owner
      .as(api().post(`/api/v1/channels/${club.id}/requests/${reader.ogcId}/approve`))
      .expect(204);
    const view = await reader.as(api().get(`/api/v1/channels/${club.id}`)).expect(200);
    expect((view.body as ChannelView).membership?.status).toBe('ACTIVE');
    expect((view.body as ChannelView).memberCount).toBe(2);
  });

  it('changes visibility only with the owner’s explicit confirmation', async () => {
    const target = await createChannel(owner);
    await owner
      .as(api().post(`/api/v1/channels/${target.id}/visibility`))
      .send({ visibility: 'PRIVATE' })
      .expect(400);
    await owner
      .as(api().put(`/api/v1/channels/${target.id}/members/${moderator.ogcId}/role`))
      .send({ role: 'ADMIN' })
      .expect(404);
    const res = await owner
      .as(api().post(`/api/v1/channels/${target.id}/visibility`))
      .send({ visibility: 'PRIVATE', confirm: true })
      .expect(200);
    const body = res.body as { channel: ChannelView; consequences: string[] };
    expect(body.channel).toMatchObject({ visibility: 'PRIVATE', endToEndEncrypted: false });
    expect(body.consequences.join(' ')).toMatch(/not end-to-end encrypted/);
    await reader.as(api().get(`/api/v1/channels/${target.id}`)).expect(404);
    const audit = await t.prisma.auditEvent.findFirst({
      where: { type: 'CHANNEL_VISIBILITY_CHANGED', userId: owner.userId },
    });
    expect(audit).not.toBeNull();
  });

  it('counts unread posts and advances the read mark', async () => {
    const before = await member.as(api().get(`/api/v1/channels/${channel.id}`)).expect(200);
    const view = before.body as ChannelView;
    await post(owner, channel.id, { body: 'Unread one' });
    const after = await member.as(api().get(`/api/v1/channels/${channel.id}`)).expect(200);
    expect((after.body as ChannelView).unreadCount).toBe(view.unreadCount + 1);
    await member
      .as(api().post(`/api/v1/channels/${channel.id}/read`))
      .send({ seq: (after.body as ChannelView).version })
      .expect(204);
    const read = await member.as(api().get(`/api/v1/channels/${channel.id}`)).expect(200);
    expect((read.body as ChannelView).unreadCount).toBe(0);
  });

  it('re-encodes images and serves other files only as downloads', async () => {
    const png = await sharp({
      create: { width: 32, height: 16, channels: 3, background: '#d4af37' },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-gps' } } })
      .toBuffer();
    const upload = await owner
      .as(api().post('/api/v1/channel-attachments'))
      .field('channelId', channel.id)
      .field('kind', 'IMAGE')
      .field('name', 'stars.png')
      .field('mime', 'image/png')
      .attach('file', png, 'x.png')
      .expect(201);
    const image = upload.body as { id: string; mime: string };
    expect(image.mime).toBe('image/webp');
    const html = await owner
      .as(api().post('/api/v1/channel-attachments'))
      .field('channelId', channel.id)
      .field('kind', 'FILE')
      .field('name', 'page.html')
      .field('mime', 'text/html')
      .attach('file', Buffer.from('<script>alert(1)</script>'), 'page.html')
      .expect(201);
    const created = (
      await post(owner, channel.id, {
        body: 'Gallery',
        attachmentIds: [image.id, (html.body as { id: string }).id],
      })
    ).body as ChannelPostView;
    expect(created.attachments).toHaveLength(2);

    const served = await reader
      .as(api().get(`/api/v1/channel-attachments/${image.id}`))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          cb(null, Buffer.concat(chunks));
        });
      })
      .expect(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect((served.body as Buffer).includes(Buffer.from('secret-gps'))).toBe(false);
    const file = await reader
      .as(api().get(`/api/v1/channel-attachments/${(html.body as { id: string }).id}`))
      .expect(200);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['content-disposition']).toMatch(/^attachment/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    // Members only can upload.
    await reader
      .as(api().post('/api/v1/channel-attachments'))
      .field('channelId', channel.id)
      .field('kind', 'FILE')
      .field('name', 'x.txt')
      .field('mime', 'text/plain')
      .attach('file', Buffer.from('x'), 'x.txt')
      .expect(403);
  });

  it('fans out realtime events to members only and stops them after a ban', async () => {
    const live = connectSocket(baseUrl, { token: member.accessToken });
    const outsider = connectSocket(baseUrl, { token: reader.accessToken });
    await Promise.all([live.connected, outsider.connected]);
    const created = (await post(owner, channel.id, { body: 'Live!' })).body as ChannelPostView;
    await eventually(
      () => live.events.filter((e) => e.event === 'channel.post_created'),
      (list) => list.some((e) => (e.payload as { postId: string }).postId === created.id),
    );
    // Payloads carry IDs only; content is fetched through authorised sync.
    const payload = live.events.find((e) => e.event === 'channel.post_created')?.payload;
    expect(Object.keys(payload as object).sort()).toEqual(['channelId', 'postId', 'version']);
    expect(outsider.events.some((e) => e.event === 'channel.post_created')).toBe(false);

    await owner
      .as(api().post(`/api/v1/channels/${channel.id}/bans/${member.ogcId}`))
      .send({ reason: 'test' })
      .expect(204);
    await eventually(() => live.events.some((e) => e.event === 'channel.access_revoked'), Boolean);
    const count = live.events.length;
    await post(owner, channel.id, { body: 'After ban' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(live.events.slice(count).some((e) => e.event === 'channel.post_created')).toBe(false);
    live.socket.disconnect();
    outsider.socket.disconnect();
  });

  it('lets only the owner delete the channel, removing its media', async () => {
    const doomed = await createChannel(owner);
    await moderator.as(api().post(`/api/v1/channels/${doomed.id}/join`)).expect(201);
    await moderator.as(api().delete(`/api/v1/channels/${doomed.id}`)).expect(403);
    await owner.as(api().delete(`/api/v1/channels/${doomed.id}`)).expect(204);
    await moderator.as(api().get(`/api/v1/channels/${doomed.id}`)).expect(404);
    expect(await t.prisma.channelMember.count({ where: { channelId: doomed.id } })).toBe(0);
  });
});
