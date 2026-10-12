import { isOgcId } from '@ogc/validation';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTER_RESPONSE } from '../src/modules/auth/auth.service.js';
import { hashToken } from '../src/modules/auth/tokens.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  createTestApp,
  register,
  setCookies,
  uniqueEmail,
  verificationTokenFrom,
} from './support/test-app.js';

describe('POST /api/v1/auth/register', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('creates a pending account with a random OGC ID, credential, profile and verification token', async () => {
    const email = uniqueEmail();
    const res = await register(t, email, PASSWORD, 'Ada Lovelace');

    expect(res.status).toBe(202);
    expect(res.body).toEqual(REGISTER_RESPONSE);

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { profile: true, credentials: true, emailVerificationTokens: true },
    });
    expect(isOgcId(user.ogcId)).toBe(true);
    expect(user.status).toBe('PENDING_VERIFICATION');
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.profile?.displayName).toBe('Ada Lovelace');
    expect(user.credentials).toHaveLength(1);
    expect(user.credentials[0]?.secretHash).toMatch(/^\$argon2id\$/);
    expect(user.credentials[0]?.secretHash).not.toContain(PASSWORD);

    // The emailed token is stored only as a hash.
    const token = verificationTokenFrom(t.emails.lastTo(email));
    expect(user.emailVerificationTokens).toHaveLength(1);
    expect(user.emailVerificationTokens[0]?.tokenHash).toBe(hashToken(token));
    expect(user.emailVerificationTokens[0]?.tokenHash).not.toBe(token);

    const audit = await t.prisma.auditEvent.findMany({ where: { userId: user.id } });
    expect(audit.map((e) => e.type)).toEqual(
      expect.arrayContaining(['USER_REGISTERED', 'EMAIL_VERIFICATION_SENT']),
    );
  });

  it('does not sign the user in before verification', async () => {
    const res = await register(t, uniqueEmail());
    expect(setCookies(res)).toHaveLength(0);
    expect(res.body).not.toHaveProperty('tokens');
  });

  it('normalises the email address', async () => {
    const local = `Mixed.Case-${Date.now()}`;
    await register(t, `  ${local}@Example.TEST `).expect(202);
    const user = await t.prisma.user.findUnique({
      where: { email: `${local.toLowerCase()}@example.test` },
    });
    expect(user).not.toBeNull();
  });

  it.each([
    ['missing @', 'not-an-email'],
    ['empty', ''],
    ['too long', `${'a'.repeat(250)}@example.test`],
  ])('rejects an invalid email (%s)', async (_label, email) => {
    const res = await register(t, email);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it.each([
    ['too short', 'short-pass'],
    ['common', 'password1234'],
    ['repetitive', 'aaaaaaaaaaaaaaaa'],
  ])('rejects an invalid password (%s)', async (_label, password) => {
    const email = uniqueEmail();
    const res = await register(t, email, password);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await t.prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('rejects unexpected fields such as a client-chosen status or OGC ID', async () => {
    const res = await request(t.server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', clientIp())
      .send({
        email: uniqueEmail(),
        password: PASSWORD,
        displayName: 'Mallory',
        status: 'ACTIVE',
        ogcId: 'OGC111111111',
      });
    expect(res.status).toBe(400);
  });

  it('answers a duplicate email exactly like a new one, without creating an account', async () => {
    const email = uniqueEmail();
    const first = await register(t, email);
    const second = await register(t, email.toUpperCase(), 'another strong passphrase', 'Imposter');

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await t.prisma.user.count({ where: { email } })).toBe(1);

    // The real owner is told someone tried; no second verification link is issued.
    expect(t.emails.lastTo(email)?.kind).toBe('account-exists');
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const events = await t.prisma.auditEvent.findMany({
      where: { userId: user.id, type: 'REGISTRATION_EMAIL_IN_USE' },
    });
    expect(events).toHaveLength(1);
  });

  it('issues a unique OGC ID to every account', async () => {
    const emails = Array.from({ length: 15 }, () => uniqueEmail());
    for (const email of emails) await register(t, email).expect(202);
    const users = await t.prisma.user.findMany({
      where: { email: { in: emails } },
      select: { ogcId: true },
    });
    expect(users).toHaveLength(emails.length);
    expect(new Set(users.map((u) => u.ogcId)).size).toBe(emails.length);
  });
});

describe('OGC ID collision handling against the database', () => {
  it('retries with a new random ID when the generated ID is already taken', async () => {
    const first = await createTestApp({ randomSource: () => 555_000_111 });
    const takenEmail = uniqueEmail();
    await register(first, takenEmail).expect(202);
    const taken = await first.prisma.user.findUniqueOrThrow({ where: { email: takenEmail } });
    expect(taken.ogcId).toBe('OGC555000111');
    await first.close();

    // The next app's generator yields the taken number first, then a free one.
    const queue = [555_000_111, 555_000_222];
    const second = await createTestApp({ randomSource: () => queue.shift() ?? 0 });
    const email = uniqueEmail();
    await register(second, email).expect(202);
    const user = await second.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.ogcId).toBe('OGC555000222');
    expect(await second.prisma.user.count({ where: { ogcId: 'OGC555000111' } })).toBe(1);
    await second.close();
  });
});
