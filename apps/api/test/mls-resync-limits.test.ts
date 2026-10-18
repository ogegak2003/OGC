import {
  type DirectoryDevice,
  type LocalDevice,
  MlsGroup,
  fromBase64,
  generateSigningKeyPair,
  toBase64,
} from '@ogc/e2ee';
import { MessagingError, TransportError } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsService } from '../src/common/metrics/metrics.js';
import { HttpTransport, eventually, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  nativeTokens,
  signedInUser,
} from './support/test-app.js';

/**
 * MLS resync limits (successful resyncs only, per device): 3 per conversation per 10 minutes and
 * 20 per device per 24 hours, enforced in PostgreSQL inside the commit transaction. Two API
 * instances share one database. Rolling windows are exercised by moving accepted resyncs back
 * in time in this isolated test database.
 */
const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

describe('MLS resync limits', () => {
  let a: TestApp;
  let b: TestApp;
  let urlA: string;
  let urlB: string;

  beforeAll(async () => {
    a = await createTestApp();
    b = await createTestApp();
    urlA = await listen(a);
    urlB = await listen(b);
  }, 120_000);

  afterAll(async () => {
    await b.close();
    await a.close();
  });

  interface Raw {
    device: LocalDevice;
    token: string;
    via: (url: string) => HttpTransport;
  }

  /** A group of `user` whose MLS group exists (created by an engine device). */
  async function group(user: TestUser, name = 'Resync group'): Promise<string> {
    const created = await user
      .as(request(a.server).post('/api/v1/groups'))
      .send({ name })
      .expect(201);
    return (created.body as { conversation: ConversationView }).conversation.id;
  }

  async function rawDevice(user: TestUser): Promise<Raw> {
    const { accessToken } = await nativeTokens(a, user.email);
    const transport = new HttpTransport(urlA, accessToken);
    const signing = await generateSigningKeyPair();
    const { deviceKeyId } = await transport.registerDeviceKey(toBase64(signing.publicKey));
    return {
      device: { ogcId: user.ogcId, deviceKeyId, signing },
      token: accessToken,
      via: (url) => new HttpTransport(url, accessToken),
    };
  }

  const directoryOf = async (t: HttpTransport, id: string): Promise<DirectoryDevice[]> =>
    (await t.directory(id)).map((d) => ({
      ogcId: d.ogcId,
      deviceKeyId: d.deviceKeyId,
      signaturePublicKey: fromBase64(d.signaturePublicKey),
    }));

  /** Builds this device's join for the group's current epoch (a resync once it is a member). */
  async function build(raw: Raw, conversationId: string, url = urlA) {
    const transport = raw.via(url);
    const server = await transport.mlsGroup(conversationId);
    const joined = await MlsGroup.joinExternal(
      raw.device,
      server.groupInfo ?? '',
      await directoryOf(transport, conversationId),
    );
    const submit = () =>
      transport.submitCommit(conversationId, {
        epoch: server.epoch,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      });
    return { server, joined, submit };
  }

  /** The device joins the group (a first, normal external join — not a resync). */
  async function join(raw: Raw, conversationId: string): Promise<void> {
    const first = await build(raw, conversationId);
    expect(first.joined.resynced).toBe(false);
    await first.submit();
  }

  async function resync(raw: Raw, conversationId: string, url = urlA) {
    const attempt = await build(raw, conversationId, url);
    expect(attempt.joined.resynced).toBe(true);
    return attempt.submit();
  }

  /** Status, code and Retry-After of a rejected submission. */
  async function outcome(p: Promise<unknown>) {
    try {
      await p;
      return { status: 201 as number, code: undefined as string | undefined, retryAfter: 0 };
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      return { status: error.status, code: error.code, retryAfter: error.retryAfterSeconds ?? 0 };
    }
  }

  const resyncRows = (deviceKeyId: string) =>
    a.prisma.mlsCommit.findMany({
      where: { senderDeviceKeyId: deviceKeyId, resync: true },
      orderBy: { createdAt: 'asc' },
      select: { conversationId: true, epoch: true, createdAt: true },
    });

  /** Moves every accepted resync of the device back by `seconds`. */
  const age = (deviceKeyId: string, seconds: number) =>
    a.prisma
      .$executeRaw`UPDATE mls_commits SET created_at = created_at - make_interval(secs => ${seconds})
      WHERE sender_device_key_id = ${deviceKeyId}::uuid AND resync`;

  type ResyncRow = Awaited<ReturnType<typeof resyncRows>>[number];

  /**
   * Sets the age (seconds before now) of each of the device's resyncs: `ages` lists them oldest
   * first, or computes one from the row itself (and its position, oldest first).
   */
  async function setAges(
    deviceKeyId: string,
    ages: number[] | ((row: ResyncRow, index: number) => number),
  ): Promise<void> {
    const rows = await resyncRows(deviceKeyId);
    if (Array.isArray(ages)) expect(rows).toHaveLength(ages.length);
    for (const [i, row] of rows.entries()) {
      const seconds = Array.isArray(ages) ? (ages[i] ?? 0) : ages(row, i);
      await a.prisma.$executeRaw`UPDATE mls_commits
        SET created_at = clock_timestamp() - make_interval(secs => ${seconds})
        WHERE conversation_id = ${row.conversationId}::uuid AND epoch = ${row.epoch}`;
    }
  }

  const resyncMetric = async (t: TestApp, outcomeLabel: string): Promise<number> => {
    const metric = await t.app.get(MetricsService).mlsResyncs.get();
    return metric.values.find((v) => v.labels.outcome === outcomeLabel)?.value ?? 0;
  };

  it('allows three resyncs per device and conversation per 10 minutes, then answers 429', async () => {
    const user = await signedInUser(a, 'Limits');
    const engine = await newDevice(a, urlA, user);
    {
      const id = await group(user);
      await engine.client.refreshConversations();
      await engine.client.send(id, { text: 'group created' });
      const raw = await rawDevice(user);
      await join(raw, id);
      const accepted = await resyncMetric(a, 'accepted');
      const limited = await resyncMetric(a, 'limited');

      for (let i = 0; i < 3; i++) expect((await outcome(resync(raw, id))).status).toBe(201);
      const before = await a.prisma.conversation.findUniqueOrThrow({ where: { id } });
      const denied = await outcome(resync(raw, id));
      expect(denied).toMatchObject({ status: 429, code: 'MLS_RESYNC_RATE_LIMITED' });
      // The window opened with the first of the three: almost all of 10 minutes remain.
      expect(denied.retryAfter).toBeGreaterThan(10 * MINUTE - 30);
      expect(denied.retryAfter).toBeLessThanOrEqual(10 * MINUTE);
      // Rolled back: no epoch, version or commit row came from the denied attempt.
      const after = await a.prisma.conversation.findUniqueOrThrow({ where: { id } });
      expect(after.mlsEpoch).toBe(before.mlsEpoch);
      expect(after.version).toBe(before.version);
      expect(await resyncRows(raw.device.deviceKeyId)).toHaveLength(3);
      // Retrying while limited does not push the window out.
      const again = await outcome(resync(raw, id));
      expect(again.status).toBe(429);
      expect(again.retryAfter).toBeLessThanOrEqual(denied.retryAfter);

      // The body names no device, account or conversation.
      const response = await fetch(`${urlA}/api/v1/conversations/${id}/mls/commits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.token}` },
        body: JSON.stringify(
          await build(raw, id).then(({ server, joined }) => ({
            epoch: server.epoch,
            commit: joined.commit,
            groupInfo: joined.groupInfo,
          })),
        ),
      });
      expect(response.status).toBe(429);
      const text = await response.text();
      for (const secret of [raw.device.deviceKeyId, user.ogcId, user.userId, id]) {
        expect(text).not.toContain(secret);
      }
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);

      expect(await resyncMetric(a, 'accepted')).toBe(accepted + 3);
      expect(await resyncMetric(a, 'limited')).toBe(limited + 3);
    }
  }, 120_000);

  it('rolls the window: allowance returns as resyncs age, with exact Retry-After', async () => {
    const user = await signedInUser(a, 'Rolling');
    const engine = await newDevice(a, urlA, user);
    const id = await group(user);
    await engine.client.refreshConversations();
    await engine.client.send(id, { text: 'group created' });
    const raw = await rawDevice(user);
    await join(raw, id);
    for (let i = 0; i < 3; i++) await resync(raw, id);

    // Oldest one minute from leaving the window: wait ~60 s for the next.
    await setAges(raw.device.deviceKeyId, [9 * MINUTE, 5 * MINUTE, 1 * MINUTE]);
    const denied = await outcome(resync(raw, id));
    expect(denied.status).toBe(429);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(58);
    expect(denied.retryAfter).toBeLessThanOrEqual(61);

    // Once it has left the window, a resync is accepted again.
    await setAges(raw.device.deviceKeyId, [10 * MINUTE + 5, 5 * MINUTE, 1 * MINUTE]);
    expect((await outcome(resync(raw, id))).status).toBe(201);
  }, 120_000);

  it('caps a device at 20 resyncs per day across conversations, and reports both limits', async () => {
    const user = await signedInUser(a, 'Daily');
    const engine = await newDevice(a, urlA, user);
    const ids = [await group(user, 'One'), await group(user, 'Two'), await group(user, 'Three')];
    await engine.client.refreshConversations();
    for (const id of ids) await engine.client.send(id, { text: 'group created' });
    const raw = await rawDevice(user);
    for (const id of ids) await join(raw, id);

    for (let i = 0; i < 20; i++) {
      expect((await outcome(resync(raw, ids[i % 3] ?? ''))).status).toBe(201);
      // Out of the 10-minute window, still inside the 24-hour one.
      await age(raw.device.deviceKeyId, 11 * MINUTE);
    }
    const denied = await outcome(resync(raw, ids[0] ?? ''));
    expect(denied).toMatchObject({ status: 429, code: 'MLS_RESYNC_RATE_LIMITED' });
    // Oldest of the 20 is 20 × 11 minutes old.
    expect(denied.retryAfter).toBeGreaterThan(DAY - 20 * 11 * MINUTE - 30);
    expect(denied.retryAfter).toBeLessThanOrEqual(DAY - 20 * 11 * MINUTE + 5);

    // Another device of the same account has its own allowance.
    const sibling = await rawDevice(user);
    await join(sibling, ids[1] ?? '');
    expect((await outcome(resync(sibling, ids[1] ?? ''))).status).toBe(201);

    // Both limits exceeded: Retry-After lets both pass. The oldest resync sets the daily wait;
    // the other resyncs in ids[0] (at least 3) are recent, the rest are older than 23 hours.
    const rows = await resyncRows(raw.device.deviceKeyId);
    expect(rows.slice(1).filter((r) => r.conversationId === ids[0]).length).toBeGreaterThanOrEqual(
      3,
    );
    const ages = (dailyOldest: number) => (row: ResyncRow, index: number) => {
      if (index === 0) return dailyOldest;
      return row.conversationId === ids[0] ? 5 * MINUTE : DAY - 30 * MINUTE;
    };
    // Daily frees in 10 minutes, the conversation window in 5: wait for the later (~600 s).
    await setAges(raw.device.deviceKeyId, ages(DAY - 10 * MINUTE));
    const both = await outcome(resync(raw, ids[0] ?? ''));
    expect(both.status).toBe(429);
    expect(both.retryAfter).toBeGreaterThanOrEqual(10 * MINUTE - 3);
    expect(both.retryAfter).toBeLessThanOrEqual(10 * MINUTE + 1);
    // Daily frees in 2 minutes, the conversation window still in 5: ~300 s.
    await setAges(raw.device.deviceKeyId, ages(DAY - 2 * MINUTE));
    const convFirst = await outcome(resync(raw, ids[0] ?? ''));
    expect(convFirst.retryAfter).toBeGreaterThanOrEqual(5 * MINUTE - 3);
    expect(convFirst.retryAfter).toBeLessThanOrEqual(5 * MINUTE + 1);
  }, 180_000);

  it('does not count rejected, stale, duplicate, unauthorized or rolled-back attempts', async () => {
    const user = await signedInUser(a, 'Rejected');
    const engine = await newDevice(a, urlA, user);
    const id = await group(user);
    await engine.client.refreshConversations();
    await engine.client.send(id, { text: 'group created' });
    const raw = await rawDevice(user);
    await join(raw, id);
    const transport = raw.via(urlA);

    // Malformed and invalid commits.
    expect(
      (await outcome(transport.submitCommit(id, { epoch: 1, commit: 'AAAA', groupInfo: 'AAAA' })))
        .status,
    ).toBe(400);
    // A stale epoch and a duplicate of an accepted resync.
    const first = await build(raw, id);
    await first.submit();
    expect((await outcome(first.submit())).code).toBe('STALE_EPOCH');
    // Submitted on the device's behalf by another device of the account.
    const other = await rawDevice(user);
    const next = await build(raw, id);
    const onBehalf = await outcome(
      other.via(urlA).submitCommit(id, {
        epoch: next.server.epoch,
        commit: next.joined.commit,
        groupInfo: next.joined.groupInfo,
      }),
    );
    expect(onBehalf.status).toBe(403);
    // Concurrent resyncs for one epoch: one commits, the others roll back.
    const racers = await Promise.all([1, 2, 3].map(() => build(raw, id)));
    const raced = await Promise.all(racers.map((r) => outcome(r.submit())));
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(raced.filter((r) => r.code === 'STALE_EPOCH')).toHaveLength(2);

    // Only the two accepted resyncs count: exactly one more is allowed.
    expect(await resyncRows(raw.device.deviceKeyId)).toHaveLength(2);
    expect((await outcome(resync(raw, id))).status).toBe(201);
    expect((await outcome(resync(raw, id))).status).toBe(429);
  }, 120_000);

  it('enforces one limit across two API instances and concurrent conversations', async () => {
    const user = await signedInUser(a, 'Instances');
    const engine = await newDevice(a, urlA, user);
    const ids = [await group(user, 'A'), await group(user, 'B'), await group(user, 'C')];
    await engine.client.refreshConversations();
    for (const id of ids) await engine.client.send(id, { text: 'group created' });
    const raw = await rawDevice(user);
    for (const id of ids) await join(raw, id);
    const [first = '', second = '', third = ''] = ids;

    // Per conversation, alternating instances.
    expect((await outcome(resync(raw, first, urlA))).status).toBe(201);
    expect((await outcome(resync(raw, first, urlB))).status).toBe(201);
    expect((await outcome(resync(raw, first, urlA))).status).toBe(201);
    expect((await outcome(resync(raw, first, urlB))).code).toBe('MLS_RESYNC_RATE_LIMITED');
    expect((await outcome(resync(raw, first, urlA))).code).toBe('MLS_RESYNC_RATE_LIMITED');

    // Device-wide: bring the device to 19 of 20, then race three conversations on two instances.
    await age(raw.device.deviceKeyId, 11 * MINUTE);
    for (let i = 0; i < 16; i++) {
      await resync(raw, ids[i % 3] ?? '', i % 2 ? urlB : urlA);
      await age(raw.device.deviceKeyId, 11 * MINUTE);
    }
    expect(await resyncRows(raw.device.deviceKeyId)).toHaveLength(19);
    const builds = [
      await build(raw, first, urlA),
      await build(raw, second, urlB),
      await build(raw, third, urlA),
    ];
    const raced = await Promise.all(builds.map((x) => outcome(x.submit())));
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(raced.filter((r) => r.code === 'MLS_RESYNC_RATE_LIMITED')).toHaveLength(2);
    expect(await resyncRows(raw.device.deviceKeyId)).toHaveLength(20);
  }, 180_000);

  it('never counts ordinary commits or first joins as resyncs', async () => {
    const user = await signedInUser(a, 'Ordinary');
    const engine = await newDevice(a, urlA, user);
    const id = await group(user);
    await engine.client.refreshConversations();
    await engine.client.send(id, { text: 'group created' });
    const raw = await rawDevice(user);
    await join(raw, id); // external join, not a resync
    await newDevice(a, urlA, user); // the engine's next send adds it (an add commit)
    await engine.client.send(id, { text: 'adds the new device' });
    const commits = await a.prisma.mlsCommit.findMany({ where: { conversationId: id } });
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits.every((c) => !c.resync)).toBe(true);
  }, 120_000);

  it('keeps the broad per-account E2EE throttle and its Retry-After', async () => {
    const user = await signedInUser(a, 'Throttle');
    const raw = await rawDevice(user);
    const id = await group(user);
    const results: { status: number; code?: string | undefined }[] = [];
    for (let i = 0; i < 125; i++) {
      results.push(
        await outcome(
          raw.via(urlA).submitCommit(id, { epoch: 0, commit: 'AAAA', groupInfo: 'AAAA' }),
        ),
      );
    }
    const limited = results.filter((r) => r.code === 'RATE_LIMITED');
    expect(limited.length).toBeGreaterThan(0);
    const response = await fetch(`${urlA}/api/v1/conversations/${id}/mls/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.token}` },
      body: JSON.stringify({ epoch: 0, commit: 'AAAA', groupInfo: 'AAAA' }),
    });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { code?: string }).code).toBe('RATE_LIMITED');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  }, 120_000);

  it('pauses only the limited conversation on the client and retries once after Retry-After', async () => {
    const user = await signedInUser(a, 'Client');
    const engine = await newDevice(a, urlA, user);
    const [id, other] = [await group(user, 'Paused'), await group(user, 'Unaffected')];
    await engine.client.refreshConversations();
    await engine.client.send(id, { text: 'group created' });
    await engine.client.send(other, { text: 'other group' });
    // A second member: ts-mls cannot resync a group's only leaf (refused by @ogc/e2ee).
    await join(await rawDevice(user), id);
    const deviceKeyId = engine.client.deviceKeyId ?? '';
    const groupState = `group:${id}`;

    // Three engine resyncs (the device keeps losing its state), all accepted.
    for (let i = 0; i < 3; i++) {
      await engine.store.delete(groupState);
      await engine.client.send(id, { text: `after resync ${String(i)}` });
    }
    expect(await resyncRows(deviceKeyId)).toHaveLength(3);
    // The oldest leaves the window in ~4 s: the server will say so.
    await setAges(deviceKeyId, [10 * MINUTE - 4, 5 * MINUTE, 1 * MINUTE]);

    let commits = 0;
    const submit = engine.transport.submitCommit;
    engine.transport.submitCommit = (...args) => {
      commits++;
      return submit(...args);
    };
    await engine.store.delete(groupState);
    await expect(engine.client.syncConversation(id)).rejects.toMatchObject({
      code: 'MLS_RESYNC_RATE_LIMITED',
    });
    expect(engine.client.resyncPausedUntil(id)).toBeGreaterThan(Date.now());
    const afterLimit = commits;
    // While paused: no further commit for this conversation, however often it syncs.
    for (let i = 0; i < 3; i++) {
      await expect(engine.client.syncConversation(id)).rejects.toBeInstanceOf(MessagingError);
    }
    expect(commits).toBe(afterLimit);
    // Other conversations keep working.
    expect(engine.client.resyncPausedUntil(other)).toBeUndefined();
    await engine.client.send(other, { text: 'still fine' });

    // The single retry timer fires after Retry-After and the resync succeeds.
    await eventually(
      async () => (await resyncRows(deviceKeyId)).length,
      (n) => n === 4,
      15_000,
    );
    expect(engine.client.resyncPausedUntil(id)).toBeUndefined();
    await engine.client.send(id, { text: 'recovered' });
  }, 120_000);
});
