import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCKOUT_THRESHOLD } from '../src/modules/auth/auth.constants.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  createActiveAccount,
  createTestApp,
  nativeLogin,
  register,
  uniqueEmail,
} from './support/test-app.js';

describe('POST /api/v1/auth/login', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('signs in with valid credentials and creates a device and session', async () => {
    const email = await createActiveAccount(t);
    const { status, body } = await nativeLogin(t, email);

    expect(status).toBe(200);
    expect(body.account).toMatchObject({ email, accountStatus: 'ACTIVE', emailVerified: true });
    expect(body.tokens?.accessToken).toMatch(/^ogc_at_/);
    expect(body.tokens?.refreshToken).toMatch(/^ogc_rt_/);
    expect(Date.parse(body.session.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(body.session.expiresAt)).toBeGreaterThan(
      Date.parse(body.session.accessTokenExpiresAt),
    );

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { sessions: true, devices: true },
    });
    expect(user.devices).toHaveLength(1);
    expect(user.devices[0]).toMatchObject({ platform: 'ANDROID', name: 'Test phone' });
    expect(user.sessions).toHaveLength(1);
    expect(user.sessions[0]?.deviceId).toBe(user.devices[0]?.id);
    expect(user.sessions[0]?.revokedAt).toBeNull();

    const events = await t.prisma.auditEvent.findMany({ where: { userId: user.id } });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['LOGIN_SUCCEEDED', 'SESSION_CREATED']),
    );
  });

  it('creates an independent session per sign-in (multiple devices)', async () => {
    const email = await createActiveAccount(t);
    const first = await nativeLogin(t, email);
    const second = await nativeLogin(t, email);
    expect(first.body.tokens?.accessToken).not.toBe(second.body.tokens?.accessToken);
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { sessions: true },
    });
    expect(user.sessions).toHaveLength(2);
  });

  it('accepts the email in any case', async () => {
    const email = await createActiveAccount(t);
    expect((await nativeLogin(t, email.toUpperCase())).status).toBe(200);
  });

  it('rejects a wrong password with a generic error and records the failure', async () => {
    const email = await createActiveAccount(t);
    const { status, body } = await nativeLogin(t, email, 'not the right password');
    expect(status).toBe(401);
    expect(body).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { credentials: true },
    });
    expect(user.credentials[0]?.failedLoginCount).toBe(1);
    const failure = await t.prisma.auditEvent.findFirst({
      where: { userId: user.id, type: 'LOGIN_FAILED' },
    });
    expect(failure?.metadata).toEqual({ reason: 'invalid_password' });
  });

  it('rejects an unknown account with the same response as a wrong password', async () => {
    const email = await createActiveAccount(t);
    const wrongPassword = await nativeLogin(t, email, 'not the right password');
    const unknown = await nativeLogin(t, uniqueEmail(), 'not the right password');
    expect(unknown.status).toBe(wrongPassword.status);
    const strip = (b: Record<string, unknown>) => ({ ...b, requestId: undefined });
    expect(strip(unknown.body)).toEqual(strip(wrongPassword.body));
  });

  it('takes comparable time for unknown accounts and wrong passwords', async () => {
    const email = await createActiveAccount(t);
    const time = async (address: string): Promise<number> => {
      const start = performance.now();
      await nativeLogin(t, address, 'not the right password');
      return performance.now() - start;
    };
    const known = (await time(email)) + (await time(email));
    const unknown = (await time(uniqueEmail())) + (await time(uniqueEmail()));
    // Both paths run a full Argon2 verification; allow generous jitter.
    expect(unknown).toBeGreaterThan(known * 0.4);
  });

  it('lets an unverified account sign in, restricted to verification endpoints', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const { status, body } = await nativeLogin(t, email);
    expect(status).toBe(200);
    expect(body.account.accountStatus).toBe('PENDING_VERIFICATION');
    const auth = `Bearer ${body.tokens?.accessToken ?? ''}`;

    await request(t.server).get('/api/v1/auth/me').set('Authorization', auth).expect(200);
    const blocked = await request(t.server)
      .get('/api/v1/test-protected')
      .set('Authorization', auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it.each(['SUSPENDED', 'DEACTIVATED'] as const)(
    'refuses a %s account, revealing the status only after a correct password',
    async (status) => {
      const email = await createActiveAccount(t);
      await t.prisma.user.update({ where: { email }, data: { status } });

      const wrong = await nativeLogin(t, email, 'not the right password');
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });

      const right = await nativeLogin(t, email);
      expect(right.status).toBe(403);
      expect(right.body).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
      expect(right.body).not.toHaveProperty('tokens');
      const sessions = await t.prisma.session.count({ where: { user: { email } } });
      expect(sessions).toBe(0);
    },
  );

  it(`locks the credential after ${LOCKOUT_THRESHOLD} consecutive failures`, async () => {
    const email = await createActiveAccount(t);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect((await nativeLogin(t, email, `wrong password ${i}`)).status).toBe(401);
    }
    // Even the correct password is refused while locked — with the generic error.
    const locked = await nativeLogin(t, email);
    expect(locked.status).toBe(401);
    expect(locked.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { credentials: true },
    });
    expect(user.credentials[0]?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(
      await t.prisma.auditEvent.count({ where: { userId: user.id, type: 'ACCOUNT_LOCKED' } }),
    ).toBe(1);

    // Once the lock expires, the correct password works and the counter resets.
    await t.prisma.credential.updateMany({
      where: { userId: user.id },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });
    expect((await nativeLogin(t, email)).status).toBe(200);
    const after = await t.prisma.credential.findFirstOrThrow({ where: { userId: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });

  it('requires a device descriptor from native clients', async () => {
    const email = await createActiveAccount(t);
    const res = await request(t.server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp())
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects malformed login requests', async () => {
    for (const body of [{}, { email: 'x@example.test' }, { email: 1, password: 2 }, 'nonsense']) {
      const res = await request(t.server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', clientIp())
        .set('Content-Type', 'application/json')
        .send(typeof body === 'string' ? body : JSON.stringify(body));
      expect(res.status).toBe(400);
    }
  });
});
