import type { DeviceSessionView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, listen, newDevice } from './support/messaging.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  cookieHeader,
  createActiveAccount,
  createTestApp,
  nativeLogin,
  nativeTokens,
} from './support/test-app.js';

const NEW_PASSWORD = 'violet harbour telescope morning';

/**
 * Phase 8 hardening: signing out other devices (lost or stolen phone) and changing the
 * password, against a real database.
 */
describe('session management and password change', () => {
  let t: TestApp;
  let baseUrl: string;

  const api = () => request(t.server);
  const as = (token: string) => ({
    get: (path: string) =>
      api().get(path).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', clientIp()),
    post: (path: string) =>
      api().post(path).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', clientIp()),
    delete: (path: string) =>
      api().delete(path).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', clientIp()),
  });

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('lists only the account’s own sessions and marks the current one', async () => {
    const email = await createActiveAccount(t);
    const phone = await nativeTokens(t, email);
    const laptop = await nativeTokens(t, email);
    const other = await nativeTokens(t, await createActiveAccount(t));

    const res = await as(phone.accessToken).get('/api/v1/auth/sessions').expect(200);
    const sessions = res.body as DeviceSessionView[];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ platform: 'ANDROID', deviceName: 'Test phone' });
    // Nothing secret in the listing.
    const text = JSON.stringify(sessions);
    for (const secret of [phone.accessToken, phone.refreshToken, laptop.accessToken]) {
      expect(text).not.toContain(secret);
    }
    const others = (await as(other.accessToken).get('/api/v1/auth/sessions').expect(200))
      .body as DeviceSessionView[];
    expect(others.map((s) => s.id)).not.toEqual(expect.arrayContaining(sessions.map((s) => s.id)));
  });

  it('signs out a lost device everywhere at once: API, refresh, keys and push', async () => {
    const email = await createActiveAccount(t);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const me = await nativeTokens(t, email);
    // The "lost" phone has an encryption device key and a push token.
    const lost = await newDevice(
      t,
      baseUrl,
      { email, ogcId: user.ogcId, userId: user.id, accessToken: '', as: (r) => r },
      true,
    );
    await api()
      .put('/api/v1/notifications/push-token')
      .set('Authorization', `Bearer ${lost.token}`)
      .set('X-Forwarded-For', clientIp())
      .send({ provider: 'EXPO', token: 'ExponentPushToken[lost-phone]' })
      .expect(204);
    const lostSession = await t.prisma.session.findFirstOrThrow({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    await as(me.accessToken).delete(`/api/v1/auth/sessions/${lostSession.id}`).expect(204);

    await as(lost.token).get('/api/v1/auth/me').expect(401);
    await eventually(
      () => t.prisma.pushToken.count({ where: { token: 'ExponentPushToken[lost-phone]' } }),
      (n) => n === 0,
    );
    await eventually(
      () =>
        t.prisma.deviceKey.count({ where: { deviceId: lostSession.deviceId, revokedAt: null } }),
      (n) => n === 0,
    );
    // The signing-out device is unaffected.
    await as(me.accessToken).get('/api/v1/auth/me').expect(200);
    const revoked = await t.prisma.session.findUniqueOrThrow({ where: { id: lostSession.id } });
    expect(revoked.revocationReason).toBe('USER_REVOKED');
  });

  it('cannot sign out someone else’s session (indistinguishable from an unknown ID)', async () => {
    const victim = await createActiveAccount(t);
    const victimTokens = await nativeTokens(t, victim);
    const victimSession = await t.prisma.session.findFirstOrThrow({
      where: { user: { email: victim }, revokedAt: null },
    });
    const attacker = await nativeTokens(t, await createActiveAccount(t));
    const forged = await as(attacker.accessToken)
      .delete(`/api/v1/auth/sessions/${victimSession.id}`)
      .expect(404);
    const unknown = await as(attacker.accessToken)
      .delete('/api/v1/auth/sessions/0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f')
      .expect(404);
    const unknownBody = unknown.body as { code: string; message: string };
    expect(forged.body).toMatchObject({ code: unknownBody.code, message: unknownBody.message });
    await as(victimTokens.accessToken).get('/api/v1/auth/me').expect(200);
    await as(attacker.accessToken).delete('/api/v1/auth/sessions/not-a-uuid').expect(400);
  });

  it('signs out every other device and keeps this one', async () => {
    const email = await createActiveAccount(t);
    const keep = await nativeTokens(t, email);
    const a = await nativeTokens(t, email);
    const b = await nativeTokens(t, email);
    const res = await as(keep.accessToken).post('/api/v1/auth/sessions/revoke-others').expect(200);
    expect(res.body).toEqual({ ended: 2 });
    await as(a.accessToken).get('/api/v1/auth/me').expect(401);
    await as(b.accessToken).get('/api/v1/auth/me').expect(401);
    // A signed-out device cannot come back with its refresh token either.
    await api()
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientIp())
      .send({ refreshToken: a.refreshToken })
      .expect(401);
    await as(keep.accessToken).get('/api/v1/auth/me').expect(200);
  });

  it('changes the password with the current one, and ends the other sessions', async () => {
    const email = await createActiveAccount(t);
    const here = await nativeTokens(t, email);
    const elsewhere = await nativeTokens(t, email);
    const res = await as(here.accessToken)
      .post('/api/v1/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);
    expect(res.body).toEqual({ otherSessionsEnded: 1 });
    await as(elsewhere.accessToken).get('/api/v1/auth/me').expect(401);
    await as(here.accessToken).get('/api/v1/auth/me').expect(200);
    expect((await nativeLogin(t, email)).status).toBe(401);
    expect((await nativeLogin(t, email, NEW_PASSWORD)).status).toBe(200);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const audit = await t.prisma.auditEvent.findMany({ where: { userId: user.id } });
    expect(audit.map((e) => e.type)).toContain('PASSWORD_CHANGED');
    // Neither password ever reaches the audit trail.
    const trail = JSON.stringify(audit);
    expect(trail).not.toContain(PASSWORD);
    expect(trail).not.toContain(NEW_PASSWORD);
  });

  it('refuses a wrong current password, weak or email-based new ones', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    const change = (body: object) =>
      as(tokens.accessToken).post('/api/v1/auth/password').send(body);
    const wrong = await change({
      currentPassword: 'not my password at all',
      newPassword: NEW_PASSWORD,
    }).expect(400);
    expect(wrong.body).toMatchObject({ code: 'INVALID_PASSWORD' });
    await change({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
    await change({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
    const local = email.split('@')[0] ?? '';
    const emailBased = await change({
      currentPassword: PASSWORD,
      newPassword: `${local} plus some words`,
    }).expect(400);
    expect(JSON.stringify(emailBased.body)).toContain('email address');
    // Nothing changed.
    expect((await nativeLogin(t, email)).status).toBe(200);
  });

  it('counts wrong current passwords towards the sign-in lockout', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    // Nine failed sign-ins, then one wrong password change: the tenth failure locks.
    for (let i = 0; i < 9; i++)
      expect((await nativeLogin(t, email, 'wrong password guess')).status).toBe(401);
    await as(tokens.accessToken)
      .post('/api/v1/auth/password')
      .send({ currentPassword: 'another wrong guess', newPassword: NEW_PASSWORD })
      .expect(400);
    expect((await nativeLogin(t, email)).status).toBe(401); // locked, even with the right one
  });

  it('rate-limits password change attempts', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await api()
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPassword: `wrong ${String(i)} guess`, newPassword: NEW_PASSWORD });
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it('requires the CSRF header for cookie-authenticated changes', async () => {
    const email = await createActiveAccount(t);
    const login = await api()
      .post('/api/v1/auth/login')
      .set('X-OGC-Client', 'web')
      .set('X-Forwarded-For', clientIp())
      .send({ email, password: PASSWORD });
    const cookie = cookieHeader(login);
    const forged = await api()
      .post('/api/v1/auth/sessions/revoke-others')
      .set('Cookie', cookie)
      .set('X-Forwarded-For', clientIp())
      .expect(403);
    expect(forged.body).toMatchObject({ code: 'CSRF_REJECTED' });
    await api()
      .post('/api/v1/auth/password')
      .set('Cookie', cookie)
      .set('X-Forwarded-For', clientIp())
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(403);
    await api()
      .post('/api/v1/auth/sessions/revoke-others')
      .set('Cookie', cookie)
      .set('X-OGC-Client', 'web')
      .set('X-Forwarded-For', clientIp())
      .expect(200);
  });
});
