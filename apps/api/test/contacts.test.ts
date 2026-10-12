import type { ContactRequestView, ContactView, Page, PublicProfile } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/common/events/domain-events.js';
import { DomainEventBus } from '../src/common/events/domain-events.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

describe('contacts', () => {
  let t: TestApp;
  const events: DomainEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    t.app.get(DomainEventBus).subscribe((event) => events.push(event));
  });

  afterAll(async () => {
    await t.close();
  });

  const send = (from: TestUser, ogcId: string) =>
    from.as(request(t.server).post('/api/v1/contacts/requests')).send({ ogcId });
  const incoming = async (user: TestUser) =>
    (await user.as(request(t.server).get('/api/v1/contacts/requests/incoming')).expect(200))
      .body as Page<ContactRequestView>;
  const outgoing = async (user: TestUser) =>
    (await user.as(request(t.server).get('/api/v1/contacts/requests/outgoing')).expect(200))
      .body as Page<ContactRequestView>;
  const relationship = async (viewer: TestUser, target: TestUser) =>
    (
      (await viewer.as(request(t.server).get(`/api/v1/profiles/${target.ogcId}`)).expect(200))
        .body as PublicProfile
    ).relationship;

  it('sends a request that appears on both sides with the right relationship state', async () => {
    const alice = await signedInUser(t, 'Alice');
    const bob = await signedInUser(t, 'Bob');
    expect((await send(alice, bob.ogcId).expect(201)).body).toEqual({
      relationship: 'OUTGOING_REQUEST',
    });

    const bobsIncoming = await incoming(bob);
    expect(bobsIncoming.items).toHaveLength(1);
    expect(bobsIncoming.items[0]?.profile).toEqual({
      ogcId: alice.ogcId,
      displayName: 'Alice',
      avatarUrl: null,
    });
    expect((await outgoing(alice)).items[0]?.profile.ogcId).toBe(bob.ogcId);
    expect(await relationship(alice, bob)).toBe('OUTGOING_REQUEST');
    expect(await relationship(bob, alice)).toBe('INCOMING_REQUEST');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'contact.request.sent',
        senderId: alice.userId,
        recipientId: bob.userId,
      }),
    );
  });

  it('rejects duplicate requests, including concurrent ones', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    const results = await Promise.all([
      send(alice, bob.ogcId),
      send(alice, bob.ogcId),
      send(alice, bob.ogcId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect((await send(alice, bob.ogcId)).status).toBe(409);
    expect(
      await t.prisma.contactRequest.count({ where: { senderId: alice.userId, status: 'PENDING' } }),
    ).toBe(1);
  });

  it('turns a mutual request into a contact', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    await send(alice, bob.ogcId).expect(201);
    expect((await send(bob, alice.ogcId).expect(201)).body).toEqual({ relationship: 'CONTACT' });
    expect(await relationship(alice, bob)).toBe('CONTACT');
  });

  it('accepts a request: both sides become contacts', async () => {
    const alice = await signedInUser(t, 'Alice');
    const bob = await signedInUser(t, 'Bob');
    await makeContacts(t, alice, bob);
    const alicesContacts = (await alice.as(request(t.server).get('/api/v1/contacts')).expect(200))
      .body as Page<ContactView>;
    const bobsContacts = (await bob.as(request(t.server).get('/api/v1/contacts')).expect(200))
      .body as Page<ContactView>;
    expect(alicesContacts.items.map((c) => c.profile.ogcId)).toEqual([bob.ogcId]);
    expect(bobsContacts.items.map((c) => c.profile.ogcId)).toEqual([alice.ogcId]);
    expect((await incoming(bob)).items).toHaveLength(0);
    expect(await relationship(alice, bob)).toBe('CONTACT');
    expect((await send(alice, bob.ogcId)).status).toBe(409);
  });

  it('declines a request and enforces a cooldown before the sender can ask again', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    await send(alice, bob.ogcId).expect(201);
    const id = (await incoming(bob)).items[0]?.id ?? '';
    await bob.as(request(t.server).post(`/api/v1/contacts/requests/${id}/decline`)).expect(204);
    expect((await outgoing(alice)).items).toHaveLength(0);
    expect(await relationship(alice, bob)).toBe('NONE');
    expect((await send(alice, bob.ogcId)).status).toBe(409);
    // Bob can still reach out himself.
    await send(bob, alice.ogcId).expect(201);
  });

  it('cancels an outgoing request', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    await send(alice, bob.ogcId).expect(201);
    const id = (await outgoing(alice)).items[0]?.id ?? '';
    await alice.as(request(t.server).delete(`/api/v1/contacts/requests/${id}`)).expect(204);
    expect((await incoming(bob)).items).toHaveLength(0);
    await send(alice, bob.ogcId).expect(201);
  });

  it('removes a contact from both sides', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    await makeContacts(t, alice, bob);
    await alice.as(request(t.server).delete(`/api/v1/contacts/${bob.ogcId}`)).expect(204);
    expect(await relationship(alice, bob)).toBe('NONE');
    expect(await relationship(bob, alice)).toBe('NONE');
    await alice.as(request(t.server).delete(`/api/v1/contacts/${bob.ogcId}`)).expect(404);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'contact.removed', userId: alice.userId }),
    );
  });

  it('rejects requests to oneself', async () => {
    const me = await signedInUser(t);
    const res = await send(me, me.ogcId);
    expect(res.status).toBe(400);
  });

  it('respects a NOBODY contact-request policy', async () => {
    const closed = await signedInUser(t);
    await closed
      .as(request(t.server).patch('/api/v1/profile'))
      .send({ privacy: { contactRequests: 'NOBODY' } })
      .expect(200);
    const res = await send(await signedInUser(t), closed.ogcId);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'CONTACT_REQUESTS_DISABLED' });
  });

  it('does not let anyone act on requests they are not a party to (IDOR)', async () => {
    const alice = await signedInUser(t);
    const bob = await signedInUser(t);
    const mallory = await signedInUser(t);
    await send(alice, bob.ogcId).expect(201);
    const id = (await incoming(bob)).items[0]?.id ?? '';

    // A third party cannot accept, decline or cancel by guessing the ID.
    await mallory.as(request(t.server).post(`/api/v1/contacts/requests/${id}/accept`)).expect(404);
    await mallory.as(request(t.server).post(`/api/v1/contacts/requests/${id}/decline`)).expect(404);
    await mallory.as(request(t.server).delete(`/api/v1/contacts/requests/${id}`)).expect(404);
    // The sender cannot accept their own request; the recipient cannot "cancel" it.
    await alice.as(request(t.server).post(`/api/v1/contacts/requests/${id}/accept`)).expect(404);
    await bob.as(request(t.server).delete(`/api/v1/contacts/requests/${id}`)).expect(404);
    // Malformed IDs are rejected the same way.
    await bob.as(request(t.server).post('/api/v1/contacts/requests/not-a-uuid/accept')).expect(404);

    expect((await incoming(bob)).items).toHaveLength(1);
    // Nobody can remove a contact relationship they are not part of.
    await makeContacts(t, alice, mallory);
    await bob.as(request(t.server).delete(`/api/v1/contacts/${mallory.ogcId}`)).expect(404);
    expect(await relationship(alice, mallory)).toBe('CONTACT');
  });

  it('paginates contacts with opaque cursors, newest first', async () => {
    const owner = await signedInUser(t);
    const friends: TestUser[] = [];
    for (let i = 0; i < 5; i++) {
      const friend = await signedInUser(t, `Friend ${i}`);
      await makeContacts(t, owner, friend);
      friends.push(friend);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = (await owner.as(request(t.server).get(`/api/v1/contacts${query}`)).expect(200))
        .body as Page<ContactView>;
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((c) => c.profile.ogcId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(friends.map((f) => f.ogcId).reverse());

    for (const bad of ['?limit=0', '?limit=500', '?cursor=bad!', '?cursor=YWJj', '?admin=true']) {
      await owner.as(request(t.server).get(`/api/v1/contacts${bad}`)).expect(400);
    }
  });

  it('requires authentication for every contact endpoint', async () => {
    for (const [method, path] of [
      ['get', '/api/v1/contacts'],
      ['post', '/api/v1/contacts/requests'],
      ['get', '/api/v1/contacts/requests/incoming'],
      ['get', '/api/v1/contacts/requests/outgoing'],
      ['delete', '/api/v1/contacts/OGC482731905'],
    ] as const) {
      expect((await request(t.server)[method](path)).status, `${method} ${path}`).toBe(401);
    }
  });
});
