import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnProfile, PublicProfile } from '@ogc/types';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp, makeContacts, signedInUser } from './support/test-app.js';

const png = (width = 640, height = 480) =>
  sharp({ create: { width, height, channels: 3, background: '#d4aa4f' } })
    .png()
    .toBuffer();

describe('own profile', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('returns the own profile with private privacy settings and privacy-leaning defaults', async () => {
    const me = await signedInUser(t, 'Ada Lovelace');
    const res = await me.as(request(t.server).get('/api/v1/profile')).expect(200);
    expect(res.body).toEqual({
      ogcId: me.ogcId,
      displayName: 'Ada Lovelace',
      bio: null,
      avatarUrl: null,
      memberSince: expect.any(String) as string,
      privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
    });
    expect(JSON.stringify(res.body)).not.toContain(me.userId);
    expect(JSON.stringify(res.body)).not.toContain(me.email);
  });

  it('applies partial updates (PATCH) and records them in the audit log', async () => {
    const me = await signedInUser(t);
    const res = await me
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ displayName: '  Grace   Hopper ', bio: 'Compilers.\n\nNavy.' })
      .expect(200);
    expect(res.body).toMatchObject({ displayName: 'Grace Hopper', bio: 'Compilers.\n\nNavy.' });

    await me
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { profileVisibility: 'EVERYONE' } })
      .expect(200);
    const after = (await me.as(request(t.server).get('/api/v1/profile')).expect(200))
      .body as OwnProfile;
    expect(after.displayName).toBe('Grace Hopper');
    expect(after.privacy).toEqual({
      profileVisibility: 'EVERYONE',
      discoverable: true,
      contactRequests: 'EVERYONE',
    });

    await me.as(request(t.server).patch('/api/v1/profile')).send({ bio: null }).expect(200);
    expect(
      ((await me.as(request(t.server).get('/api/v1/profile')).expect(200)).body as OwnProfile).bio,
    ).toBeNull();

    const audit = await t.prisma.auditEvent.findMany({ where: { userId: me.userId } });
    expect(audit.map((e) => e.type)).toEqual(
      expect.arrayContaining(['PROFILE_UPDATED', 'PRIVACY_SETTINGS_CHANGED']),
    );
  });

  it.each([
    ['empty update', {}],
    ['blank display name', { displayName: '   ' }],
    ['long display name', { displayName: 'x'.repeat(65) }],
    ['long bio', { bio: 'x'.repeat(281) }],
    ['invalid visibility', { privacy: { profileVisibility: 'PUBLIC' } }],
    ['ownership field', { bio: 'x', userId: '00000000-0000-4000-8000-000000000000' }],
    ['identity field', { bio: 'x', ogcId: 'OGC111111111' }],
    ['storage field', { avatarKey: 'avatars/../../etc/passwd' }],
  ])('rejects %s', async (_label, body) => {
    const me = await signedInUser(t);
    const res = await me.as(request(t.server).patch('/api/v1/profile')).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('requires authentication to read or change a profile', async () => {
    await request(t.server).get('/api/v1/profile').expect(401);
    await request(t.server).patch('/api/v1/profile').send({ bio: 'x' }).expect(401);
    await request(t.server)
      .post('/api/v1/profile/avatar')
      .attach('avatar', await png(), 'a.png')
      .expect(401);
  });
});

describe('public profiles and privacy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const view = (viewer: Awaited<ReturnType<typeof signedInUser>>, ogcId: string) =>
    viewer.as(request(t.server).get(`/api/v1/profiles/${ogcId}`));

  it('shows only the display name to non-contacts by default', async () => {
    const owner = await signedInUser(t, 'Private Person');
    await owner
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ bio: 'Secret bio' })
      .expect(200);
    const stranger = await signedInUser(t);

    const res = await view(stranger, owner.ogcId).expect(200);
    expect(res.body).toEqual({
      ogcId: owner.ogcId,
      displayName: 'Private Person',
      bio: null,
      avatarUrl: null,
      memberSince: null,
      relationship: 'NONE',
      canSendContactRequest: true,
      pendingRequestId: null,
    });
  });

  it('shows bio and member-since to everyone when visibility is EVERYONE', async () => {
    const owner = await signedInUser(t);
    await owner
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ bio: 'Open book', privacy: { profileVisibility: 'EVERYONE' } })
      .expect(200);
    const res = await view(await signedInUser(t), owner.ogcId).expect(200);
    expect(res.body).toMatchObject({ bio: 'Open book', memberSince: expect.any(String) as string });
  });

  it('shows details to contacts even when visibility is CONTACTS', async () => {
    const owner = await signedInUser(t);
    await owner
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ bio: 'For friends' })
      .expect(200);
    const friend = await signedInUser(t);
    await makeContacts(t, friend, owner);
    const res = await view(friend, owner.ogcId).expect(200);
    expect(res.body).toMatchObject({ bio: 'For friends', relationship: 'CONTACT' });
  });

  it('never returns private fields', async () => {
    const owner = await signedInUser(t);
    const res = await view(await signedInUser(t), owner.ogcId).expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(owner.userId);
    expect(text).not.toContain(owner.email);
    expect(text).not.toMatch(/privacy|discoverable|session|device|password|secret/i);
  });

  it('describes the viewer themselves as SELF', async () => {
    const me = await signedInUser(t);
    expect((await view(me, me.ogcId).expect(200)).body).toMatchObject({
      relationship: 'SELF',
      canSendContactRequest: false,
    });
  });

  it('hides non-discoverable accounts from everyone but their contacts', async () => {
    const hidden = await signedInUser(t);
    const friend = await signedInUser(t);
    await makeContacts(t, friend, hidden);
    await hidden
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { discoverable: false } })
      .expect(200);

    const stranger = await signedInUser(t);
    const missing = await view(stranger, 'OGC999999998');
    const res = await view(stranger, hidden.ogcId);
    expect(res.status).toBe(404);
    expect({ ...res.body, requestId: null }).toEqual({ ...missing.body, requestId: null });
    await view(friend, hidden.ogcId).expect(200);
  });

  it('reports CONTACT_REQUESTS_DISABLED through canSendContactRequest', async () => {
    const owner = await signedInUser(t);
    await owner
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { contactRequests: 'NOBODY' } })
      .expect(200);
    expect((await view(await signedInUser(t), owner.ogcId).expect(200)).body).toMatchObject({
      relationship: 'NONE',
      canSendContactRequest: false,
    });
  });

  it('does not show pending, suspended or deactivated accounts', async () => {
    for (const status of ['PENDING_VERIFICATION', 'SUSPENDED', 'DEACTIVATED'] as const) {
      const owner = await signedInUser(t);
      await t.prisma.user.update({ where: { id: owner.userId }, data: { status } });
      await view(await signedInUser(t), owner.ogcId).expect(404);
    }
  });

  it('rejects malformed OGC IDs', async () => {
    const me = await signedInUser(t);
    for (const bad of ['OGC123', 'not-an-id', 'OGC000000001']) {
      const res = await view(me, bad);
      expect(res.status).toBe(400);
    }
  });
});

describe('profile photos', () => {
  let t: TestApp;
  const storageRoot = join(tmpdir(), 'ogc-test-storage');

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const upload = (user: Awaited<ReturnType<typeof signedInUser>>, data: Buffer, filename: string) =>
    user.as(request(t.server).post('/api/v1/profile/avatar')).attach('avatar', data, filename);

  it('accepts an image, re-encodes it as 512×512 WebP, and serves it to the owner', async () => {
    const me = await signedInUser(t);
    const res = await upload(me, await png(1200, 800), 'holiday.png').expect(200);
    const profile = res.body as OwnProfile;
    expect(profile.avatarUrl).toMatch(
      new RegExp(`^/api/v1/profiles/${me.ogcId}/avatar\\?v=[0-9a-f]{8}$`),
    );

    const image = await me
      .as(request(t.server).get(profile.avatarUrl ?? ''))
      .buffer(true)
      .expect(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.headers['cache-control']).toContain('private');
    const meta = await sharp(image.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
  });

  it('ignores the client filename entirely (no path traversal, no leakage)', async () => {
    const me = await signedInUser(t);
    const res = await upload(me, await png(), '../../../etc/passwd.png').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('passwd');
    const { avatarKey } = await t.prisma.profile.findUniqueOrThrow({
      where: { userId: me.userId },
    });
    expect(avatarKey).toMatch(/^avatars\/[0-9a-f-]{36}\.webp$/);
    expect(await readdir(join(storageRoot, 'avatars'))).toContain(avatarKey?.split('/')[1]);
  });

  it.each([
    ['an executable', Buffer.from('MZ\x90\x00\x03 this is a Windows program'), 'photo.png'],
    ['a script disguised as an image', Buffer.from('<script>alert(1)</script>'), 'photo.jpg'],
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'photo.svg'],
    [
      'a truncated PNG',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      'p.png',
    ],
  ])('rejects %s', async (_label, data, filename) => {
    const me = await signedInUser(t);
    const res = await upload(me, data, filename);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MEDIA' });
    const { avatarKey } = await t.prisma.profile.findUniqueOrThrow({
      where: { userId: me.userId },
    });
    expect(avatarKey).toBeNull();
  });

  it('rejects files over 5 MB', async () => {
    const me = await signedInUser(t);
    const oversized = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const res = await upload(me, oversized, 'big.png');
    expect(res.status).toBe(413);
  });

  it('rejects requests without a file or with extra fields', async () => {
    const me = await signedInUser(t);
    expect((await me.as(request(t.server).post('/api/v1/profile/avatar')).send({})).status).toBe(
      400,
    );
    const extra = await me
      .as(request(t.server).post('/api/v1/profile/avatar'))
      .field('userId', 'someone-else')
      .attach('avatar', await png(), 'a.png');
    expect(extra.status).toBe(400);
  });

  it('replaces and removes photos, deleting the old files', async () => {
    const me = await signedInUser(t);
    await upload(me, await png(), 'one.png').expect(200);
    const first = (await t.prisma.profile.findUniqueOrThrow({ where: { userId: me.userId } }))
      .avatarKey;
    await upload(me, await png(300, 300), 'two.png').expect(200);
    const second = (await t.prisma.profile.findUniqueOrThrow({ where: { userId: me.userId } }))
      .avatarKey;
    expect(second).not.toBe(first);
    const files = await readdir(join(storageRoot, 'avatars'));
    expect(files).not.toContain(first?.split('/')[1]);
    expect(files).toContain(second?.split('/')[1]);

    const removed = await me.as(request(t.server).delete('/api/v1/profile/avatar')).expect(200);
    expect((removed.body as OwnProfile).avatarUrl).toBeNull();
    expect(await readdir(join(storageRoot, 'avatars'))).not.toContain(second?.split('/')[1]);
  });

  it('serves photos only to viewers allowed by the privacy settings', async () => {
    const owner = await signedInUser(t);
    await upload(owner, await png(), 'me.png').expect(200);
    const url = `/api/v1/profiles/${owner.ogcId}/avatar`;

    await request(t.server).get(url).expect(401);
    const stranger = await signedInUser(t);
    await stranger.as(request(t.server).get(url)).expect(404);
    const strangerView = await stranger.as(
      request(t.server).get(`/api/v1/profiles/${owner.ogcId}`),
    );
    expect((strangerView.body as PublicProfile).avatarUrl).toBeNull();

    const friend = await signedInUser(t);
    await makeContacts(t, friend, owner);
    await friend.as(request(t.server).get(url)).expect(200);

    await owner
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { profileVisibility: 'EVERYONE' } })
      .expect(200);
    await stranger.as(request(t.server).get(url)).expect(200);
  });
});
