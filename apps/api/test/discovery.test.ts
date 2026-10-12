import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOCIAL_RATE_LIMITS } from '../src/modules/relationships/social.constants.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  nativeTokens,
  register,
  signedInUser,
  uniqueEmail,
} from './support/test-app.js';

describe('OGC ID discovery', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const lookup = (viewer: TestUser, input: string) =>
    viewer.as(request(t.server).get(`/api/v1/discovery/ogc/${encodeURIComponent(input)}`));
  const withoutRequestId = (body: unknown) => ({ ...(body as object), requestId: null });

  it('finds an account by its exact OGC ID, as typed by a person', async () => {
    const target = await signedInUser(t, 'Found Person');
    const viewer = await signedInUser(t);
    const grouped = `${target.ogcId.slice(0, 3)} ${target.ogcId.slice(3, 6)} ${target.ogcId.slice(6, 9)} ${target.ogcId.slice(9)}`;
    for (const input of [target.ogcId, grouped.toLowerCase()]) {
      const res = await lookup(viewer, input).expect(200);
      expect(res.body).toMatchObject({
        ogcId: target.ogcId,
        displayName: 'Found Person',
        relationship: 'NONE',
        canSendContactRequest: true,
      });
    }
  });

  it('answers unknown and hidden accounts identically', async () => {
    const viewer = await signedInUser(t);
    const hidden = await signedInUser(t);
    await hidden
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { discoverable: false } })
      .expect(200);

    const unknown = await lookup(viewer, 'OGC999999997');
    const notDiscoverable = await lookup(viewer, hidden.ogcId);
    expect(unknown.status).toBe(404);
    expect(notDiscoverable.status).toBe(404);
    expect(withoutRequestId(notDiscoverable.body)).toEqual(withoutRequestId(unknown.body));
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects malformed input without a database lookup', async () => {
    const viewer = await signedInUser(t);
    for (const bad of ['OGC12', 'OGC000000001', 'hello', 'OGC48273190A']) {
      const res = await lookup(viewer, bad);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('hides someone who blocked the viewer exactly like a nonexistent account', async () => {
    const blocker = await signedInUser(t);
    const viewer = await signedInUser(t);
    await blocker.as(request(t.server).post(`/api/v1/blocks/${viewer.ogcId}`)).expect(204);

    const res = await lookup(viewer, blocker.ogcId);
    const unknown = await lookup(viewer, 'OGC999999996');
    expect(res.status).toBe(404);
    expect(withoutRequestId(res.body)).toEqual(withoutRequestId(unknown.body));
    // The blocker still sees the person they blocked, marked as BLOCKED.
    expect((await lookup(blocker, viewer.ogcId).expect(200)).body).toMatchObject({
      relationship: 'BLOCKED',
      canSendContactRequest: false,
      bio: null,
    });
  });

  it('lets contacts find a non-discoverable account', async () => {
    const hidden = await signedInUser(t);
    const friend = await signedInUser(t);
    await makeContacts(t, friend, hidden);
    await hidden
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { discoverable: false } })
      .expect(200);
    expect((await lookup(friend, hidden.ogcId).expect(200)).body).toMatchObject({
      relationship: 'CONTACT',
    });
  });

  it('requires an authenticated, verified account', async () => {
    const target = await signedInUser(t);
    await request(t.server).get(`/api/v1/discovery/ogc/${target.ogcId}`).expect(401);

    const email = uniqueEmail();
    await register(t, email).expect(202);
    const { accessToken } = await nativeTokens(t, email);
    const pending = await request(t.server)
      .get(`/api/v1/discovery/ogc/${target.ogcId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(pending.status).toBe(403);
    expect(pending.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it(`limits lookups per account (${SOCIAL_RATE_LIMITS.discovery.limit}/min), whatever the IP`, async () => {
    const enumerator = await signedInUser(t);
    for (let i = 0; i < SOCIAL_RATE_LIMITS.discovery.limit; i++) {
      // Each request comes from a different IP: limits follow the account, not the address.
      const res = await lookup(enumerator, `OGC${String(100_000_000 + i)}`);
      expect(res.status).toBe(404);
    }
    const limited = await lookup(enumerator, 'OGC100000999');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });

    // Other accounts are unaffected.
    const other = await signedInUser(t);
    expect((await lookup(other, 'OGC100000999')).status).toBe(404);
  });
});
