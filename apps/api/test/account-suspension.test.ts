import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSocket, eventually, listen } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  clientIp,
  createTestApp,
  nativeLogin,
  signedInUser,
} from './support/test-app.js';

/**
 * Phase 9: suspension takes effect at once — API, refresh, device sessions and open
 * WebSocket connections — rather than when access tokens expire.
 */
describe('account suspension', () => {
  let t: TestApp;
  let baseUrl: string;
  let admin: TestUser;
  const saved = { ...process.env };

  const api = () => request(t.server);
  const suspend = (as: TestUser, ogcId: string, reason = 'Spam campaign (report #17)') =>
    as.as(api().post(`/api/v1/admin/accounts/${ogcId}/suspend`)).send({ reason });
  const reinstate = (as: TestUser, ogcId: string) =>
    as
      .as(api().post(`/api/v1/admin/accounts/${ogcId}/reinstate`))
      .send({ reason: 'Appeal upheld' });

  /** A signed-in user with an open realtime connection. */
  async function online() {
    const user = await signedInUser(t, 'Target');
    const live = connectSocket(baseUrl, { token: user.accessToken });
    await live.connected;
    const closed = new Promise<string>((resolve) => {
      live.socket.once('disconnect', resolve);
    });
    return { user, live, closed };
  }

  beforeAll(async () => {
    // A fast re-check, so status changes made outside the API are picked up within the test.
    process.env.REALTIME_SESSION_CHECK_MS = '1000';
    t = await createTestApp();
    baseUrl = await listen(t);
    admin = await signedInUser(t, 'Admin');
    await t.prisma.staffRoleAssignment.create({ data: { userId: admin.userId, role: 'ADMIN' } });
  });

  afterAll(async () => {
    await t.close();
    process.env = saved;
  });

  it('ends API access, refresh and open sockets immediately', async () => {
    const { user, live, closed } = await online();
    const login = await nativeLogin(t, user.email);
    const refreshToken = login.body.tokens?.refreshToken ?? '';

    const res = await suspend(admin, user.ogcId).expect(200);
    expect(res.body).toEqual({ status: 'SUSPENDED', sessionsEnded: 2 });

    await expect(closed).resolves.toBe('io server disconnect');
    await user.as(api().get('/api/v1/auth/me')).expect(401);
    await api()
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientIp())
      .send({ refreshToken })
      .expect(401);
    await expect(connectSocket(baseUrl, { token: user.accessToken }).connected).rejects.toThrow(
      'unauthorized',
    );
    // Signing in again is refused while suspended.
    expect((await nativeLogin(t, user.email)).status).toBe(403);
    expect(live.socket.connected).toBe(false);

    const sessions = await t.prisma.session.findMany({ where: { userId: user.userId } });
    expect(sessions.every((s) => s.revocationReason === 'ACCOUNT_DISABLED')).toBe(true);
    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { userId: user.userId, type: 'ACCOUNT_SUSPENDED' },
    });
    expect(audit.metadata).toEqual({ actor: admin.ogcId, reason: 'Spam campaign (report #17)' });
  });

  it('closes sockets within one check when the status changes outside the API', async () => {
    const { user, closed } = await online();
    // An operator suspends the account directly in the database.
    await t.prisma.user.update({ where: { id: user.userId }, data: { status: 'SUSPENDED' } });
    await expect(closed).resolves.toBe('io server disconnect');
    await eventually(
      () => t.prisma.session.count({ where: { userId: user.userId, revokedAt: null } }),
      (n) => n === 0,
    );
  });

  it('closes sockets of a session revoked outside the API', async () => {
    const { user, closed } = await online();
    await t.prisma.session.updateMany({
      where: { userId: user.userId },
      data: { revokedAt: new Date(), revocationReason: 'LOGOUT' },
    });
    await expect(closed).resolves.toBe('io server disconnect');
  });

  it('reinstates: the person signs in again; old sessions stay ended', async () => {
    const { user } = await online();
    await suspend(admin, user.ogcId).expect(200);
    expect((await reinstate(admin, user.ogcId).expect(200)).body).toEqual({ status: 'ACTIVE' });
    await user.as(api().get('/api/v1/auth/me')).expect(401);
    expect((await nativeLogin(t, user.email)).status).toBe(200);
    const types = (
      await t.prisma.auditEvent.findMany({ where: { userId: user.userId }, select: { type: true } })
    ).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ACCOUNT_SUSPENDED', 'ACCOUNT_REINSTATED']));
  });

  it('is idempotent and keeps the account and its data', async () => {
    const { user } = await online();
    await suspend(admin, user.ogcId).expect(200);
    const again = await suspend(admin, user.ogcId).expect(200);
    expect(again.body).toEqual({ status: 'SUSPENDED', sessionsEnded: 0 });
    expect(
      await t.prisma.auditEvent.count({
        where: { userId: user.userId, type: 'ACCOUNT_SUSPENDED' },
      }),
    ).toBe(1);
    expect(await t.prisma.user.count({ where: { id: user.userId } })).toBe(1);
    expect(await t.prisma.profile.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('is for administrators only, never self-service, and validates input', async () => {
    const { user } = await online();
    const moderator = await signedInUser(t, 'Moderator');
    await t.prisma.staffRoleAssignment.create({
      data: { userId: moderator.userId, role: 'MODERATOR' },
    });
    const ordinary = await signedInUser(t, 'Ordinary');
    await suspend(ordinary, user.ogcId).expect(403);
    await suspend(moderator, user.ogcId).expect(403);
    await suspend(user, user.ogcId).expect(403);
    await suspend(admin, admin.ogcId).expect(403);
    await suspend(admin, user.ogcId, '').expect(400);
    await suspend(admin, 'not-an-id').expect(400);
    await suspend(admin, 'OGC999999993').expect(404);
    await api()
      .post(`/api/v1/admin/accounts/${user.ogcId}/suspend`)
      .set('X-Forwarded-For', clientIp())
      .send({ reason: 'no auth' })
      .expect(401);
    await user.as(api().get('/api/v1/auth/me')).expect(200);
  });
});
