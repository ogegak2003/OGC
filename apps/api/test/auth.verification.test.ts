import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/modules/auth/tokens.js';
import {
  type TestApp,
  clientIp,
  createTestApp,
  nativeTokens,
  register,
  uniqueEmail,
  verificationTokenFrom,
} from './support/test-app.js';

describe('email verification', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const verify = (token: string) =>
    request(t.server)
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', clientIp())
      .send({ token });

  it('sends a link carrying the token in the URL fragment, not the query string', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const message = t.emails.lastTo(email);
    expect(message?.kind).toBe('verify-email');
    expect(message?.text).toMatch(/http:\/\/localhost:5173\/verify-email#token=[A-Za-z0-9_-]{43}/);
    expect(message?.text).not.toMatch(/\?token=/);
  });

  it('activates the account with a valid token, exactly once', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const token = verificationTokenFrom(t.emails.lastTo(email));

    expect((await verify(token).expect(200)).body).toEqual({ verified: true });
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.status).toBe('ACTIVE');
    expect(user.emailVerifiedAt).not.toBeNull();

    const reused = await verify(token);
    expect(reused.status).toBe(400);
    expect(reused.body).toMatchObject({ code: 'INVALID_VERIFICATION_TOKEN' });
  });

  it('rejects expired and unknown tokens with the same response', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const token = verificationTokenFrom(t.emails.lastTo(email));
    await t.prisma.emailVerificationToken.update({
      where: { tokenHash: hashToken(token) },
      data: {
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 1),
      },
    });

    const expired = await verify(token);
    const unknown = await verify('A'.repeat(43));
    expect(expired.status).toBe(400);
    expect(unknown.status).toBe(400);
    const withoutRequestId = (body: unknown) => ({ ...(body as object), requestId: undefined });
    expect(withoutRequestId(expired.body)).toEqual(withoutRequestId(unknown.body));
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email } })).status).toBe(
      'PENDING_VERIFICATION',
    );
  });

  it('rejects malformed tokens before touching the database', async () => {
    for (const token of ['', 'short', `${'a'.repeat(42)}!`]) {
      const res = await verify(token);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('never lifts a suspension', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const token = verificationTokenFrom(t.emails.lastTo(email));
    await t.prisma.user.update({ where: { email }, data: { status: 'SUSPENDED' } });
    await verify(token).expect(200);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email } })).status).toBe('SUSPENDED');
  });

  it('re-sends a new link to a signed-in pending user and invalidates the old one', async () => {
    const email = uniqueEmail();
    await register(t, email).expect(202);
    const oldToken = verificationTokenFrom(t.emails.lastTo(email));
    const { accessToken } = await nativeTokens(t, email);
    // Pretend the first email was sent long enough ago.
    await t.prisma.emailVerificationToken.updateMany({
      where: { user: { email } },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });

    const resend = () =>
      request(t.server)
        .post('/api/v1/auth/verify-email/resend')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Forwarded-For', clientIp());
    await resend().expect(202);
    const newToken = verificationTokenFrom(t.emails.lastTo(email));
    expect(newToken).not.toBe(oldToken);

    // A second request within the resend interval is accepted but sends nothing.
    const count = t.emails.sent.length;
    await resend().expect(202);
    expect(t.emails.sent.length).toBe(count);

    await verify(oldToken).expect(400);
    await verify(newToken).expect(200);
  });

  it('requires authentication to re-send', async () => {
    await request(t.server).post('/api/v1/auth/verify-email/resend').expect(401);
  });
});
