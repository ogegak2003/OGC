import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetentionService } from '../src/modules/retention/retention.service.js';
import {
  type TestApp,
  createActiveAccount,
  createTestApp,
  nativeTokens,
} from './support/test-app.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/**
 * Retention cleanup against a real database. Small batches make the bounds observable; the
 * periodic timer is off so only explicit runs delete anything.
 */
describe('retention cleanup', () => {
  let t: TestApp;
  let retention: RetentionService;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.RETENTION_ENABLED = 'false';
    process.env.RETENTION_BATCH_SIZE = '10';
    process.env.RETENTION_MAX_BATCHES = '2';
    t = await createTestApp();
    retention = t.app.get(RetentionService);
  });

  afterAll(async () => {
    await t.close();
    process.env = saved;
  });

  /** A user with one real session per entry, then each session's state set as given. */
  async function userWithSessions(
    states: { revokedAt?: Date; expiresAt?: Date; createdAt?: Date }[],
  ): Promise<{ userId: string; sessionIds: string[] }> {
    const email = await createActiveAccount(t);
    for (const _ of states) await nativeTokens(t, email);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const sessions = await t.prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    for (const [i, state] of states.entries()) {
      const session = sessions[i];
      if (!session) throw new Error('missing session');
      await t.prisma.session.update({
        where: { id: session.id },
        data: {
          ...(state.createdAt ? { createdAt: state.createdAt } : {}),
          ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
          ...(state.revokedAt ? { revokedAt: state.revokedAt, revocationReason: 'LOGOUT' } : {}),
        },
      });
    }
    return { userId: user.id, sessionIds: sessions.map((s) => s.id) };
  }

  const exists = async (ids: string[]) =>
    (await t.prisma.session.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
      (s) => s.id,
    );

  it('deletes only sessions that ended longer ago than the retention period', async () => {
    const { sessionIds } = await userWithSessions([
      {}, // active
      { revokedAt: ago(5) }, // recently signed out: kept
      { revokedAt: ago(100), createdAt: ago(120), expiresAt: ago(90) }, // old: removed
      { createdAt: ago(150), expiresAt: ago(120) }, // expired long ago, never revoked: removed
      { createdAt: ago(60), expiresAt: ago(30) }, // expired recently: kept
    ]);
    const [active, recent, oldRevoked, oldExpired, recentExpired] = sessionIds as [
      string,
      string,
      string,
      string,
      string,
    ];
    await retention.run();
    expect((await exists(sessionIds)).sort()).toEqual([active, recent, recentExpired].sort());
    expect(await exists([oldRevoked, oldExpired])).toEqual([]);
  });

  it('never deletes the account, its devices or a current session', async () => {
    const { userId, sessionIds } = await userWithSessions([{}, { revokedAt: ago(200) }]);
    const before = {
      users: await t.prisma.user.count({ where: { id: userId } }),
      devices: await t.prisma.device.count({ where: { userId } }),
      credentials: await t.prisma.credential.count({ where: { userId } }),
    };
    await retention.run();
    await retention.run();
    expect({
      users: await t.prisma.user.count({ where: { id: userId } }),
      devices: await t.prisma.device.count({ where: { userId } }),
      credentials: await t.prisma.credential.count({ where: { userId } }),
    }).toEqual(before);
    expect(await exists(sessionIds)).toEqual([sessionIds[0]]);
  });

  it('removes used and expired tokens after the token period, never live ones', async () => {
    const email = await createActiveAccount(t);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    const token = (createdAt: Date, expiresAt: Date, consumedAt: Date | null) =>
      t.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          createdAt,
          expiresAt,
          consumedAt,
        },
      });
    const live = await token(new Date(), new Date(Date.now() + 30 * 60_000), null);
    const usedRecently = await token(ago(2), ago(1.9), ago(1.95));
    const usedLongAgo = await token(ago(30), ago(29.9), ago(29.95));
    const expiredLongAgo = await token(ago(30), ago(29.9), null);
    const oldVerification = await t.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '1'),
        createdAt: ago(40),
        expiresAt: ago(39),
      },
    });

    await retention.run();
    const left = await t.prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    expect(left.map((r) => r.id).sort()).toEqual([live.id, usedRecently.id].sort());
    expect(left.map((r) => r.id)).not.toContain(usedLongAgo.id);
    expect(left.map((r) => r.id)).not.toContain(expiredLongAgo.id);
    expect(await t.prisma.emailVerificationToken.count({ where: { id: oldVerification.id } })).toBe(
      0,
    );
  });

  it('deletes audit events only past the audit period, and records counts only', async () => {
    const userId = randomUUID();
    const old = await t.prisma.auditEvent.create({
      data: { type: 'LOGIN_SUCCEEDED', userId, createdAt: ago(800) },
    });
    const kept = await t.prisma.auditEvent.create({
      data: { type: 'LOGIN_SUCCEEDED', userId, createdAt: ago(400) },
    });
    const report = await retention.run();
    expect(report.auditEvents).toBeGreaterThanOrEqual(1);
    expect(await t.prisma.auditEvent.count({ where: { id: old.id } })).toBe(0);
    expect(await t.prisma.auditEvent.count({ where: { id: kept.id } })).toBe(1);
    const summary = await t.prisma.auditEvent.findFirst({
      where: { type: 'RETENTION_PURGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(summary?.userId).toBeNull();
    expect(Object.keys(summary?.metadata as object).sort()).toEqual(
      ['auditEvents', 'resetTokens', 'sessions', 'verificationTokens'].sort(),
    );
  });

  it('keeps everything of an account under a retention hold', async () => {
    const { userId, sessionIds } = await userWithSessions([
      { revokedAt: ago(300), createdAt: ago(320), expiresAt: ago(290) },
    ]);
    const event = await t.prisma.auditEvent.create({
      data: { type: 'LOGIN_FAILED', userId, createdAt: ago(900) },
    });
    await t.prisma.retentionHold.create({ data: { userId, reason: 'Security investigation #42' } });
    await retention.run();
    expect(await exists(sessionIds)).toEqual(sessionIds);
    expect(await t.prisma.auditEvent.count({ where: { id: event.id } })).toBe(1);

    // Releasing the hold lets the next run catch up.
    await t.prisma.retentionHold.delete({ where: { userId } });
    await retention.run();
    expect(await exists(sessionIds)).toEqual([]);
    expect(await t.prisma.auditEvent.count({ where: { id: event.id } })).toBe(0);
  });

  it('works in bounded batches and converges over repeated runs (idempotent)', async () => {
    const userId = randomUUID();
    await t.prisma.auditEvent.createMany({
      data: Array.from({ length: 45 }, () => ({
        type: 'LOGIN_FAILED' as const,
        userId,
        createdAt: ago(1000),
      })),
    });
    const remaining = () => t.prisma.auditEvent.count({ where: { userId } });
    // Batch 10 × at most 2 batches per run: never more than 20 per run.
    const first = await retention.run();
    expect(first.auditEvents).toBeLessThanOrEqual(20);
    expect(await remaining()).toBeGreaterThanOrEqual(25);
    for (let i = 0; i < 5; i++) await retention.run();
    expect(await remaining()).toBe(0);
    expect((await retention.run()).auditEvents).toBe(0);
  });

  it('the database itself refuses audit deletions outside the retention job and under a year old', async () => {
    const event = await t.prisma.auditEvent.create({
      data: { type: 'LOGIN_SUCCEEDED', createdAt: ago(800) },
    });
    // No opt-in: refused, however old.
    await expect(t.prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(
      t.prisma.auditEvent.update({ where: { id: event.id }, data: { userAgent: 'x' } }),
    ).rejects.toThrow();
    // Opted in, but younger than the 365-day floor: refused.
    const young = await t.prisma.auditEvent.create({
      data: { type: 'LOGIN_SUCCEEDED', createdAt: ago(200) },
    });
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('ogc.audit_retention', 'on', true)`;
        await tx.$executeRaw`DELETE FROM "audit_events" WHERE "id" = ${young.id}::uuid`;
      }),
    ).rejects.toThrow(/append-only/);
    expect(await t.prisma.auditEvent.count({ where: { id: young.id } })).toBe(1);
  });

  it('lets only one run at a time do the work', async () => {
    const userId = randomUUID();
    await t.prisma.auditEvent.createMany({
      data: Array.from({ length: 5 }, () => ({
        type: 'LOGIN_FAILED' as const,
        userId,
        createdAt: ago(1000),
      })),
    });
    const [a, b] = await Promise.all([retention.run(), retention.run()]);
    // The second call returns at once (this instance is already running).
    expect(a.auditEvents + b.auditEvents).toBeGreaterThanOrEqual(5);
    expect(Math.min(a.auditEvents, b.auditEvents)).toBe(0);
    expect(await t.prisma.auditEvent.count({ where: { userId } })).toBe(0);
  });
});
