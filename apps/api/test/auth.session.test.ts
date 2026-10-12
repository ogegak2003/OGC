import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/modules/auth/tokens.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  cookieHeader,
  createActiveAccount,
  createTestApp,
  nativeTokens,
  setCookies,
} from './support/test-app.js';

describe('sessions', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const me = (accessToken: string) =>
    request(t.server).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (refreshToken: string) =>
    request(t.server)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientIp())
      .send({ refreshToken });

  it('authenticates a valid access token and returns the public account', async () => {
    const email = await createActiveAccount(t);
    const { accessToken } = await nativeTokens(t, email);
    const res = await me(accessToken).expect(200);
    expect(Object.keys(res.body as object).sort()).toEqual(
      ['accountStatus', 'createdAt', 'displayName', 'email', 'emailVerified', 'ogcId'].sort(),
    );
  });

  it('rejects requests without, or with malformed, credentials', async () => {
    await request(t.server).get('/api/v1/auth/me').expect(401);
    for (const header of [
      'Bearer',
      'Bearer ',
      'Basic abc',
      'Bearer ogc_at_short',
      `Bearer ${'x'.repeat(50)}`,
    ]) {
      const res = await request(t.server).get('/api/v1/auth/me').set('Authorization', header);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('logs out the current session; its tokens stop working', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    const other = await nativeTokens(t, email);

    await request(t.server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(204);

    await me(tokens.accessToken).expect(401);
    await refresh(tokens.refreshToken).expect(401);
    // Other devices are unaffected.
    await me(other.accessToken).expect(200);

    const session = await t.prisma.session.findFirstOrThrow({
      where: { accessTokenHash: hashToken(tokens.accessToken) },
    });
    expect(session.revocationReason).toBe('LOGOUT');
  });

  it('rejects an expired access token, which the refresh token can renew', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    await t.prisma.session.update({
      where: { accessTokenHash: hashToken(tokens.accessToken) },
      data: { accessExpiresAt: new Date(Date.now() - 1_000) },
    });
    await me(tokens.accessToken).expect(401);

    const renewed = await refresh(tokens.refreshToken).expect(200);
    const next = (renewed.body as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    expect(next.accessToken).not.toBe(tokens.accessToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    await me(next.accessToken).expect(200);
  });

  it('refuses to refresh past the absolute session lifetime', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    const session = await t.prisma.session.findUniqueOrThrow({
      where: { accessTokenHash: hashToken(tokens.accessToken) },
    });
    await t.prisma.session.update({
      where: { id: session.id },
      data: { createdAt: new Date(Date.now() - 10_000), expiresAt: new Date(Date.now() - 1_000) },
    });
    await refresh(tokens.refreshToken).expect(401);
    await me(tokens.accessToken).expect(401);
  });

  it('rotates refresh tokens and revokes the session when an old one is reused', async () => {
    const email = await createActiveAccount(t);
    const original = await nativeTokens(t, email);
    const rotated = (
      (await refresh(original.refreshToken).expect(200)).body as {
        tokens: { accessToken: string; refreshToken: string };
      }
    ).tokens;

    // Replaying the superseded token signals theft: the whole session is revoked.
    await refresh(original.refreshToken).expect(401);
    await me(rotated.accessToken).expect(401);
    await refresh(rotated.refreshToken).expect(401);

    const session = await t.prisma.session.findFirstOrThrow({
      where: { accessTokenHash: hashToken(rotated.accessToken) },
    });
    expect(session.revocationReason).toBe('REFRESH_TOKEN_REUSE');
    expect(
      await t.prisma.auditEvent.count({
        where: { sessionId: session.id, type: 'REFRESH_TOKEN_REUSE_DETECTED' },
      }),
    ).toBe(1);
  });

  it('rejects malformed and unknown refresh tokens', async () => {
    await refresh('garbage').expect(401);
    await refresh(`ogc_rt_00000000-0000-4000-8000-000000000000_${'a'.repeat(43)}`).expect(401);
    await request(t.server)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientIp())
      .send({})
      .expect(401);
  });

  it('immediately cuts off sessions of an account that is suspended', async () => {
    const email = await createActiveAccount(t);
    const tokens = await nativeTokens(t, email);
    await t.prisma.user.update({ where: { email }, data: { status: 'SUSPENDED' } });

    const res = await me(tokens.accessToken);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
    const session = await t.prisma.session.findFirstOrThrow({
      where: { accessTokenHash: hashToken(tokens.accessToken) },
    });
    expect(session.revocationReason).toBe('ACCOUNT_DISABLED');
    await refresh(tokens.refreshToken).expect(401);
  });
});

describe('browser sessions (HttpOnly cookies)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const webLogin = async (email: string) =>
    request(t.server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp())
      .set('X-OGC-Client', 'web')
      .send({ email, password: PASSWORD });

  it('sets HttpOnly, SameSite=Strict cookies and never returns tokens to the browser', async () => {
    const email = await createActiveAccount(t);
    const res = await webLogin(email);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('tokens');
    expect(JSON.stringify(res.body)).not.toMatch(/ogc_(at|rt)_/);

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
    }
    expect(cookies.find((c) => c.startsWith('ogc_rt='))).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookies.find((c) => c.startsWith('ogc_at='))).toMatch(/Path=\/;/);

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { devices: true },
    });
    expect(user.devices[0]?.platform).toBe('WEB');
  });

  it('authenticates safe requests with the cookie', async () => {
    const email = await createActiveAccount(t);
    const cookie = cookieHeader(await webLogin(email));
    const res = await request(t.server).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(res.body).toMatchObject({ email });
  });

  it('rejects cookie-authenticated state changes without the client header (CSRF)', async () => {
    const email = await createActiveAccount(t);
    const cookie = cookieHeader(await webLogin(email));

    const forged = await request(t.server).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(forged.status).toBe(403);
    expect(forged.body).toMatchObject({ code: 'CSRF_REJECTED' });
    await request(t.server).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    const res = await request(t.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set('X-OGC-Client', 'web')
      .expect(204);
    // Cookies are cleared and the session no longer authenticates.
    expect(setCookies(res).every((c) => c.includes('Expires=Thu, 01 Jan 1970'))).toBe(true);
    await request(t.server).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
  });

  it('refreshes from the refresh cookie and rotates both cookies', async () => {
    const email = await createActiveAccount(t);
    const cookie = cookieHeader(await webLogin(email));

    // Without the client header the cookie is not even read.
    await request(t.server).post('/api/v1/auth/refresh').set('Cookie', cookie).send({}).expect(401);

    const res = await request(t.server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('X-OGC-Client', 'web')
      .set('X-Forwarded-For', clientIp())
      .send({})
      .expect(200);
    expect(res.body).not.toHaveProperty('tokens');
    const next = cookieHeader(res);
    expect(next).not.toBe(cookie);
    await request(t.server).get('/api/v1/auth/me').set('Cookie', next).expect(200);
  });
});
