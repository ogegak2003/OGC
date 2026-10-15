import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen, newDevice } from './support/messaging.js';
import { type TestApp, createTestApp, makeContacts, signedInUser } from './support/test-app.js';

/**
 * Key-change warnings with the real messaging engine against the real API: when the other
 * person gains a device key this device has never seen, the conversation is flagged and a
 * previous "verified" mark is cleared.
 */
describe('key-change warnings', () => {
  let t: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('detects a new device of the other person and clears verification', async () => {
    const alice = await signedInUser(t, 'Alice');
    const bob = await signedInUser(t, 'Bob');
    await makeContacts(t, alice, bob);
    const alicePhone = await newDevice(t, baseUrl, alice);
    await newDevice(t, baseUrl, bob);
    const conversation = await alicePhone.client.openDirect(bob.ogcId);
    const engine = alicePhone.client;

    // First sight: trusted silently.
    expect(await engine.peerKeyStatus(conversation.id)).toEqual({ state: 'unverified', added: 0 });
    expect(await engine.peerKeyStatus(conversation.id)).toEqual({ state: 'unverified', added: 0 });

    // Alice compares safety numbers with Bob and marks him verified.
    await engine.markPeerVerified(conversation.id);
    expect((await engine.peerKeyStatus(conversation.id)).state).toBe('verified');

    // Bob signs in on a new device (or a server substitutes a key): flagged, verification gone.
    await newDevice(t, baseUrl, bob);
    expect(await engine.peerKeyStatus(conversation.id)).toEqual({ state: 'changed', added: 1 });
    expect((await engine.peerKeyStatus(conversation.id)).state).toBe('changed');

    // Alice acknowledges it: no longer flagged, but not verified either.
    await engine.acknowledgePeerKeys(conversation.id);
    expect(await engine.peerKeyStatus(conversation.id)).toEqual({ state: 'unverified', added: 0 });
  });

  it('keeps the warning on this device even after the engine restarts', async () => {
    const carol = await signedInUser(t, 'Carol');
    const dave = await signedInUser(t, 'Dave');
    await makeContacts(t, carol, dave);
    const carolPhone = await newDevice(t, baseUrl, carol);
    await newDevice(t, baseUrl, dave);
    const conversation = await carolPhone.client.openDirect(dave.ogcId);
    await carolPhone.client.peerKeyStatus(conversation.id);
    await newDevice(t, baseUrl, dave);
    expect((await carolPhone.client.peerKeyStatus(conversation.id)).state).toBe('changed');
    // The record lives in the device's sealed store, not in memory.
    await carolPhone.client.start();
    expect((await carolPhone.client.peerKeyStatus(conversation.id)).state).toBe('changed');
  });
});
