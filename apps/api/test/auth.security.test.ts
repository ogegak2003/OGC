import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_RATE_LIMITS } from '../src/modules/auth/auth.constants.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  createTestApp,
  register,
  uniqueEmail,
  verificationTokenFrom,
} from './support/test-app.js';

// Capture everything the application logs, at the most verbose level.
process.env.LOG_LEVEL = 'trace';

describe('authentication security properties', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('never returns or logs passwords, hashes, or tokens across the full flow', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const verificationToken = verificationTokenFrom(t.emails.lastTo(email));
    await request(t.server)
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', clientIp())
      .send({ token: verificationToken })
      .expect(200);

    const login = await request(t.server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp())
      .send({ email, password: PASSWORD, device: { platform: 'IOS' } })
      .expect(200);
    const { accessToken, refreshToken } = (login.body as { tokens: Record<string, string> })
      .tokens as {
      accessToken: string;
      refreshToken: string;
    };
    const me = await request(t.server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', `ogc_at=${accessToken}`)
      .expect(200);
    const refreshed = await request(t.server)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientIp())
      .send({ refreshToken })
      .expect(200);
    await request(t.server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp())
      .send({
        email,
        password: 'a wrong password attempt',
        device: { platform: 'IOS' },
      });

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { credentials: true, sessions: true },
    });
    const secretHash = user.credentials[0]?.secretHash ?? 'missing';

    // Responses expose no password, hash, or internal identifiers.
    for (const body of [login.body, me.body, refreshed.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(secretHash);
      expect(text).not.toContain('$argon2');
      expect(text).not.toContain(user.id);
      expect(text).not.toMatch(/secretHash|tokenHash|failedLoginCount|lockedUntil/);
    }

    // Logs were produced, but contain no secret material.
    const logs = t.logs();
    expect(logs.length).toBeGreaterThan(1_000);
    expect(logs).toContain('request completed');
    for (const secret of [
      PASSWORD,
      'a wrong password attempt',
      secretHash,
      verificationToken,
      accessToken,
      refreshToken,
      (refreshed.body as { tokens: { refreshToken: string } }).tokens.refreshToken,
    ]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toContain('$argon2');
    expect(logs).not.toMatch(/ogc_(at|rt)_[A-Za-z0-9_-]{20}/);

    // Audit records hold context, never credentials.
    const audit = JSON.stringify(
      await t.prisma.auditEvent.findMany({ where: { userId: user.id } }),
    );
    for (const secret of [PASSWORD, secretHash, verificationToken, accessToken, refreshToken]) {
      expect(audit).not.toContain(secret);
    }
  });

  it('rejects unauthenticated access to protected endpoints', async () => {
    for (const [method, path] of [
      ['get', '/api/v1/auth/me'],
      ['post', '/api/v1/auth/logout'],
      ['post', '/api/v1/auth/verify-email/resend'],
      ['get', '/api/v1/test-protected'],
    ] as const) {
      const res = await request(t.server)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it(`rate limits login attempts per client IP (${AUTH_RATE_LIMITS.login.limit}/min)`, async () => {
    const ip = clientIp();
    const attempt = (from: string) =>
      request(t.server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', from)
        .send({ email: uniqueEmail(), password: 'whatever it is', device: { platform: 'WEB' } });

    for (let i = 0; i < AUTH_RATE_LIMITS.login.limit; i++) {
      expect((await attempt(ip)).status).toBe(401);
    }
    const limited = await attempt(ip);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBeDefined();

    // Other clients are unaffected.
    expect((await attempt(clientIp())).status).toBe(401);
  });

  it(`rate limits registration per client IP (${AUTH_RATE_LIMITS.register.limit}/hour)`, async () => {
    const ip = clientIp();
    const attempt = () =>
      request(t.server)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', ip)
        .send({ email: 'not-an-email', password: PASSWORD, displayName: 'x' });
    for (let i = 0; i < AUTH_RATE_LIMITS.register.limit; i++) {
      expect((await attempt()).status).toBe(400);
    }
    expect((await attempt()).status).toBe(429);
  });

  it('gives identical answers for registered and unregistered emails', async () => {
    const existing = uniqueEmail();
    await register(t, existing).expect(202);
    const again = await register(t, existing);
    const fresh = await register(t, uniqueEmail());
    expect(again.status).toBe(fresh.status);
    expect(again.body).toEqual(fresh.body);
    expect(again.headers['set-cookie']).toEqual(fresh.headers['set-cookie']);
  });

  it('rejects malformed JSON and wrong content types on auth endpoints', async () => {
    const malformed = await request(t.server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp())
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(malformed.status).toBe(400);

    const text = await request(t.server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', clientIp())
      .set('Content-Type', 'text/plain')
      .send(`email=${uniqueEmail()}`);
    expect(text.status).toBe(400);
  });
});
