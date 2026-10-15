import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventually, listen, newDevice } from './support/messaging.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  createActiveAccount,
  createTestApp,
  nativeLogin,
  nativeTokens,
  uniqueEmail,
} from './support/test-app.js';

const NEW_PASSWORD = 'violet harbour telescope morning';
const GENERIC = /If an account uses this email address/;

/**
 * Phase 9 password recovery against a real database, with a capturing email sender (MOCKED:
 * no real provider is contacted here; see email/senders.test.ts for the SMTP wire test).
 */
describe('password reset', () => {
  let t: TestApp;
  let baseUrl: string;

  const api = () => request(t.server);
  const forgot = (email: string, ip = clientIp()) =>
    api().post('/api/v1/auth/password/forgot').set('X-Forwarded-For', ip).send({ email });
  const reset = (token: string, newPassword = NEW_PASSWORD, ip = clientIp()) =>
    api()
      .post('/api/v1/auth/password/reset')
      .set('X-Forwarded-For', ip)
      .send({ token, newPassword });

  /** The reset token from the last reset email to `email` (waits for background delivery). */
  async function resetTokenFor(email: string): Promise<string> {
    const message = await eventually(
      () => t.emails.sent.filter((m) => m.to === email && m.kind === 'password-reset').at(-1),
      (m) => m !== undefined,
    );
    const token = /\/reset-password#token=(ogc_pr_[A-Za-z0-9_-]{43})\n/.exec(
      message?.text ?? '',
    )?.[1];
    if (!token) throw new Error('No reset token in email');
    return token;
  }

  const resetEmails = (email: string) =>
    t.emails.sent.filter((m) => m.to === email && m.kind === 'password-reset');

  /** Pretends earlier reset emails were sent long enough ago for a new one to be allowed. */
  const ageResetTokens = (email: string, minutes: number) =>
    t.prisma.passwordResetToken.updateMany({
      where: { user: { email } },
      data: { createdAt: new Date(Date.now() - minutes * 60_000) },
    });

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
  });

  beforeEach(() => {
    t.emails.available = true;
    t.emails.failing = false;
  });

  afterAll(async () => {
    await t.close();
  });

  it('resets the password with the emailed link and signs out every device', async () => {
    const email = await createActiveAccount(t);
    const phone = await nativeTokens(t, email);
    const laptop = await nativeTokens(t, email);

    const res = await forgot(email).expect(202);
    expect((res.body as { message: string }).message).toMatch(GENERIC);
    const token = await resetTokenFor(email);

    expect(await reset(token).expect(200)).toMatchObject({ body: { reset: true } });

    for (const session of [phone, laptop]) {
      await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(401);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    }
    expect((await nativeLogin(t, email)).status).toBe(401);
    expect((await nativeLogin(t, email, NEW_PASSWORD)).status).toBe(200);

    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const reasons = await t.prisma.session.findMany({
      where: { userId: user.id, revocationReason: 'PASSWORD_RESET' },
    });
    expect(reasons).toHaveLength(2);
    // The owner is told, so a reset they did not make does not go unnoticed.
    await eventually(() =>
      t.emails.sent.some((m) => m.to === email && m.kind === 'password-changed'),
    );
  });

  it('refuses to reuse a link (replay) and stores only its hash', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const token = await resetTokenFor(email);
    const stored = await t.prisma.passwordResetToken.findMany({ where: { user: { email } } });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    await reset(token).expect(200);
    const replay = await reset(token, 'another fine password here').expect(400);
    expect(replay.body).toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    expect((await nativeLogin(t, email, 'another fine password here')).status).toBe(401);
  });

  it('lets only one of two simultaneous uses of a link succeed', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const token = await resetTokenFor(email);
    const results = await Promise.all([
      reset(token, 'first concurrent password choice'),
      reset(token, 'second concurrent password choice'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results.find((r) => r.status === 200) === results[0] ? 'first' : 'second';
    expect((await nativeLogin(t, email, `${winner} concurrent password choice`)).status).toBe(200);
  });

  it('refuses expired links', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const token = await resetTokenFor(email);
    await t.prisma.passwordResetToken.updateMany({
      where: { user: { email } },
      // Issued an hour ago with the default 30-minute lifetime.
      data: {
        createdAt: new Date(Date.now() - 60 * 60_000),
        expiresAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    expect((await reset(token).expect(400)).body).toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    expect((await nativeLogin(t, email)).status).toBe(200);
  });

  it('supersedes an earlier link when a new one is sent', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const first = await resetTokenFor(email);
    await ageResetTokens(email, 2);
    await forgot(email).expect(202);
    await eventually(() => resetEmails(email).length === 2);
    const second = await resetTokenFor(email);
    expect(second).not.toBe(first);
    await reset(first).expect(400);
    await reset(second).expect(200);
  });

  it('answers identically for unknown, suspended and real accounts, emailing only the real one', async () => {
    const real = await createActiveAccount(t);
    const suspended = await createActiveAccount(t);
    await t.prisma.user.update({ where: { email: suspended }, data: { status: 'SUSPENDED' } });
    const unknown = uniqueEmail();

    const answers = [];
    for (const email of [real, suspended, unknown]) {
      const res = await forgot(email);
      answers.push({ status: res.status, body: res.body as unknown });
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    await resetTokenFor(real);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(resetEmails(suspended)).toEqual([]);
    expect(t.emails.sent.filter((m) => m.to === unknown)).toEqual([]);
    // The reason is recorded for the operator only.
    const outcomes = await t.prisma.auditEvent.findMany({
      where: { type: 'PASSWORD_RESET_REQUESTED', createdAt: { gt: new Date(Date.now() - 60_000) } },
      select: { metadata: true },
    });
    expect(outcomes.map((e) => e.metadata)).toEqual(
      expect.arrayContaining([{ outcome: 'unknown_account' }, { outcome: 'account_unavailable' }]),
    );
  });

  it('limits reset emails per account without changing the answer', async () => {
    const email = await createActiveAccount(t);
    const first = await forgot(email).expect(202);
    await resetTokenFor(email);
    const second = await forgot(email).expect(202);
    expect(second.body).toEqual(first.body);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(resetEmails(email)).toHaveLength(1);
  });

  it('refuses a reset for an account suspended after the link was sent', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const token = await resetTokenFor(email);
    await t.prisma.user.update({ where: { email }, data: { status: 'SUSPENDED' } });
    expect((await reset(token).expect(400)).body).toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  it('keeps the link usable when the new password is refused', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const token = await resetTokenFor(email);
    await reset(token, 'short').expect(400);
    const local = email.split('@')[0] ?? '';
    await reset(token, `${local} plus some words`).expect(400);
    await reset(token).expect(200);
  });

  it('rejects malformed tokens before touching the database', async () => {
    for (const token of [
      '',
      'A'.repeat(43),
      `ogc_at_${'A'.repeat(43)}`,
      `ogc_pr_${'A'.repeat(43)}x`,
    ]) {
      expect((await reset(token).expect(400)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await reset(`ogc_pr_${'A'.repeat(43)}`).expect(400);
  });

  it('clears a sign-in lockout once the password is reset', async () => {
    const email = await createActiveAccount(t);
    for (let i = 0; i < 10; i++) await nativeLogin(t, email, 'wrong password guess');
    expect((await nativeLogin(t, email)).status).toBe(401); // locked
    await forgot(email).expect(202);
    await reset(await resetTokenFor(email)).expect(200);
    expect((await nativeLogin(t, email, NEW_PASSWORD)).status).toBe(200);
  });

  it('does not touch encryption keys itself; signed-out devices lose theirs as on any sign-out', async () => {
    const email = await createActiveAccount(t);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    await newDevice(t, baseUrl, {
      email,
      ogcId: user.ogcId,
      userId: user.id,
      accessToken: '',
      as: (r) => r,
    });
    expect(await t.prisma.deviceKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    await forgot(email).expect(202);
    await reset(await resetTokenFor(email)).expect(200);
    await eventually(
      () => t.prisma.deviceKey.count({ where: { userId: user.id, revokedAt: null } }),
      (n) => n === 0,
    );
    // The account itself and its server-side data remain.
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email } })).status).toBe('ACTIVE');
  });

  it('never writes tokens or passwords to the audit trail or logs', async () => {
    const email = await createActiveAccount(t);
    await forgot(email).expect(202);
    const token = await resetTokenFor(email);
    await reset(token).expect(200);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const trail = JSON.stringify(
      await t.prisma.auditEvent.findMany({ where: { userId: user.id } }),
    );
    expect(trail).toContain('PASSWORD_RESET_COMPLETED');
    for (const secret of [token, NEW_PASSWORD, PASSWORD]) {
      expect(trail).not.toContain(secret);
      expect(t.logs()).not.toContain(secret);
    }
    expect(t.logs()).not.toContain('reset-password#');
  });

  it('is honest when no email provider is configured, for every address', async () => {
    t.emails.available = false;
    const known = await forgot(await createActiveAccount(t)).expect(503);
    const unknown = await forgot(uniqueEmail()).expect(503);
    expect(known.body).toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    const { requestId } = unknown.body as { requestId?: string };
    expect(unknown.body).toEqual({ ...(known.body as object), requestId });
  });

  it('hides provider failures from the requester and retires the undeliverable link', async () => {
    const email = await createActiveAccount(t);
    t.emails.failing = true;
    const res = await forgot(email).expect(202);
    expect((res.body as { message: string }).message).toMatch(GENERIC);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    await eventually(
      () =>
        t.prisma.auditEvent.count({
          where: { userId: user.id, type: 'PASSWORD_RESET_FAILED' },
        }),
      (n) => n === 1,
    );
    const tokens = await t.prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens.every((row) => row.consumedAt !== null)).toBe(true);
  });

  it('rate-limits requests and reset attempts per client', async () => {
    const ip = clientIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await forgot(uniqueEmail(), ip)).status);
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);

    const guesses: number[] = [];
    const resetIp = clientIp();
    for (let i = 0; i < 11; i++) {
      const guess = `ogc_pr_${String(i).padStart(43, 'A')}`;
      guesses.push((await reset(guess, NEW_PASSWORD, resetIp)).status);
    }
    expect(guesses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(guesses[10]).toBe(429);
  });
});
