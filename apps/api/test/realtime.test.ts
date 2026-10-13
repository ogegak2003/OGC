import type { ConversationView, MessageView, OgcId, PresenceView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestDevice,
  type TestSocket,
  connectSocket,
  eventually,
  listen,
  newDevice,
} from './support/messaging.js';
import {
  PASSWORD,
  type TestApp,
  type TestUser,
  clientIp,
  cookieHeader,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/**
 * The realtime gateway (Socket.IO, protocol v1): authentication, authorization
 * of every event, privacy of typing and presence, and the closed event contract.
 */
describe('realtime gateway', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let mallory: TestUser;
  let aliceDevice: TestDevice;
  let bobDevice: TestDevice;
  let conversation: ConversationView;
  const sockets: TestSocket[] = [];

  async function online(token: string) {
    const connection = connectSocket(baseUrl, { token });
    sockets.push(connection.socket);
    await connection.connected;
    return connection;
  }

  const received = (events: { event: string; payload: unknown }[], name: string) =>
    events.filter((e) => e.event === name).map((e) => e.payload);

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob, mallory] = await Promise.all([
      signedInUser(t, 'Alice'),
      signedInUser(t, 'Bob'),
      signedInUser(t, 'Mallory'),
    ]);
    await makeContacts(t, alice, bob);
    aliceDevice = await newDevice(t, baseUrl, alice);
    bobDevice = await newDevice(t, baseUrl, bob);
    conversation = await aliceDevice.client.openDirect(bob.ogcId);
    await aliceDevice.client.send(conversation.id, { text: 'warm-up' });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await t.close();
  });

  it('rejects connections without a valid session', async () => {
    await expect(connectSocket(baseUrl, {}).connected).rejects.toThrow('unauthorized');
    await expect(connectSocket(baseUrl, { token: 'ogc_at_forged' }).connected).rejects.toThrow(
      'unauthorized',
    );
  });

  it('accepts browser cookies only from an allowed origin (cross-site WebSocket hijacking)', async () => {
    const login = await request(t.server)
      .post('/api/v1/auth/login')
      .set('X-OGC-Client', 'web')
      .set('X-Forwarded-For', clientIp())
      .send({ email: alice.email, password: PASSWORD });
    const cookie = cookieHeader(login);
    await expect(connectSocket(baseUrl, { cookie }).connected).rejects.toThrow();
    await expect(
      connectSocket(baseUrl, { cookie, origin: 'https://evil.example' }).connected,
    ).rejects.toThrow();
    const allowed = connectSocket(baseUrl, { cookie, origin: 'http://localhost:5173' });
    sockets.push(allowed.socket);
    await expect(allowed.connected).resolves.toBeUndefined();
  });

  it('pushes new messages to the recipient and the sender’s other devices only', async () => {
    const bobLive = await online(bobDevice.token);
    const aliceOther = await newDevice(t, baseUrl, alice);
    const aliceOtherLive = await online(aliceOther.token);
    const malloryLive = await online(mallory.accessToken);

    const sent = await aliceDevice.client.send(conversation.id, { text: 'live!' });
    const created = await eventually(
      () => received(bobLive.events, 'message.created'),
      (list) => list.length > 0,
    );
    expect((created[0] as { message: MessageView }).message.id).toBe(sent.id);
    // The payload carries ciphertext only.
    expect(JSON.stringify(created[0])).not.toContain('live!');
    await eventually(
      () => received(aliceOtherLive.events, 'message.created'),
      (list) => list.length > 0,
    );
    expect(received(malloryLive.events, 'message.created')).toEqual([]);

    // The realtime event lets the recipient's engine sync and decrypt immediately.
    bobDevice.client.handleRealtime('message.created', created[0] as { message: MessageView });
    await eventually(
      async () => (await bobDevice.client.messages(conversation.id)).at(-1)?.payload?.text,
      (text) => text === 'live!',
    );
  });

  it('relays typing only between participants, and expires nothing it was not told', async () => {
    const aliceLive = await online(aliceDevice.token);
    const bobLive = await online(bobDevice.token);
    const malloryLive = await online(mallory.accessToken);

    aliceLive.socket.emit('typing.start', { conversationId: conversation.id });
    await eventually(
      () => received(bobLive.events, 'message.typing'),
      (list) => list.length > 0,
    );
    expect(received(bobLive.events, 'message.typing')[0]).toEqual({
      conversationId: conversation.id,
      ogcId: alice.ogcId,
      typing: true,
    });
    aliceLive.socket.emit('typing.stop', { conversationId: conversation.id });
    await eventually(
      () => received(bobLive.events, 'message.typing'),
      (list) => list.length > 1,
    );
    expect(received(bobLive.events, 'message.typing')[1]).toMatchObject({ typing: false });

    // A non-participant cannot inject typing into the conversation; forged fields are rejected.
    malloryLive.socket.emit('typing.start', { conversationId: conversation.id });
    aliceLive.socket.emit('typing.start', {
      conversationId: conversation.id,
      ogcId: mallory.ogcId,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received(bobLive.events, 'message.typing')).toHaveLength(2);
  });

  it('shares presence only with conversation partners', async () => {
    const bobLive = await online(bobDevice.token);
    const malloryLive = await online(mallory.accessToken);
    const subscribe = (socket: TestSocket, ogcIds: string[]) =>
      new Promise<{ ok: boolean; data?: PresenceView[] }>((resolve) => {
        socket.emit('presence.subscribe', { ogcIds: ogcIds as never }, resolve);
      });

    const aliceLive = await online(aliceDevice.token);
    const forBob = await subscribe(bobLive.socket, [alice.ogcId]);
    expect(forBob).toEqual({ ok: true, data: [{ ogcId: alice.ogcId, state: 'ONLINE' }] });
    // Mallory shares no conversation with Alice: she learns nothing, not even "offline".
    expect(await subscribe(malloryLive.socket, [alice.ogcId])).toEqual({ ok: true, data: [] });
    expect(await subscribe(malloryLive.socket, ['not-an-id'])).toEqual({
      ok: false,
      error: 'invalid',
    });

    // When every Alice connection closes, Bob sees her go offline.
    for (const socket of sockets) {
      if (socket !== bobLive.socket && socket !== malloryLive.socket) socket.disconnect();
    }
    aliceLive.socket.disconnect();
    await eventually(
      () => received(bobLive.events, 'presence.updated'),
      (list) => list.some((p) => (p as PresenceView).state === 'OFFLINE'),
    );
    expect(received(malloryLive.events, 'presence.updated')).toEqual([]);
  });

  it('stops typing and presence across a block in both directions', async () => {
    const bobLive = await online(bobDevice.token);
    const aliceLive = await online(aliceDevice.token);
    await request(t.server)
      .post(`/api/v1/blocks/${alice.ogcId}`)
      .set('Authorization', `Bearer ${bobDevice.token}`)
      .expect(204);
    const before = received(aliceLive.events, 'message.typing').length;
    bobLive.socket.emit('typing.start', { conversationId: conversation.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received(aliceLive.events, 'message.typing')).toHaveLength(before);
    const ack = await new Promise<{ ok: boolean; data?: PresenceView[] }>((resolve) => {
      aliceLive.socket.emit('presence.subscribe', { ogcIds: [bob.ogcId as OgcId] }, resolve);
    });
    expect(ack).toEqual({ ok: true, data: [] });
    await request(t.server)
      .delete(`/api/v1/blocks/${alice.ogcId}`)
      .set('Authorization', `Bearer ${bobDevice.token}`)
      .expect(204);
  });

  it('disconnects clients that send events outside the contract', async () => {
    const live = await online(aliceDevice.token);
    const closed = new Promise<string>((resolve) => {
      live.socket.once('disconnect', resolve);
    });
    (live.socket as unknown as { emit: (event: string, payload: unknown) => void }).emit(
      'admin.grant',
      {},
    );
    await expect(closed).resolves.toBe('io server disconnect');
  });

  it('closes a session’s sockets when it logs out', async () => {
    const device = await newDevice(t, baseUrl, alice, false);
    const live = await online(device.token);
    const closed = new Promise<string>((resolve) => {
      live.socket.once('disconnect', resolve);
    });
    await request(t.server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${device.token}`)
      .expect(204);
    await expect(closed).resolves.toBe('io server disconnect');
    await expect(connectSocket(baseUrl, { token: device.token }).connected).rejects.toThrow(
      'unauthorized',
    );
  });

  it('recovers messages missed while disconnected through sync', async () => {
    const bobLive = await online(bobDevice.token);
    bobLive.socket.disconnect();
    await aliceDevice.client.send(conversation.id, { text: 'while you were away' });
    const reconnected = await online(bobDevice.token);
    expect(received(reconnected.events, 'message.created')).toEqual([]);
    await bobDevice.client.syncAll();
    expect((await bobDevice.client.messages(conversation.id)).at(-1)?.payload?.text).toBe(
      'while you were away',
    );
  });

  it('emits read receipts to the sender', async () => {
    const aliceLive = await online(aliceDevice.token);
    await bobDevice.client.markRead(conversation.id);
    const reads = await eventually(
      () => received(aliceLive.events, 'message.read'),
      (list) => list.length > 0,
    );
    expect(reads[0]).toMatchObject({ conversationId: conversation.id, ogcId: bob.ogcId });
  });
});
