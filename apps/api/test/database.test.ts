import { execSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/database/prisma.service.js';
import { type TestApp, createTestApp, uniqueEmail } from './support/test-app.js';

function prismaCli(args: string): { status: number; output: string } {
  try {
    const output = execSync(`pnpm exec prisma ${args}`, {
      env: { ...process.env },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { status: 0, output };
  } catch (error) {
    const { status, stdout, stderr } = error as { status: number; stdout: string; stderr: string };
    return { status, output: `${stdout}${stderr}` };
  }
}

describe('database schema and migrations', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.prisma;
  });

  afterAll(async () => {
    await t.close();
  });

  async function createUser(overrides: { ogcId?: string; email?: string } = {}) {
    return prisma.user.create({
      data: {
        ogcId: overrides.ogcId ?? `OGC${String(randomInt(100_000_000, 1_000_000_000))}`,
        email: overrides.email ?? uniqueEmail(),
        profile: { create: { displayName: 'DB Test' } },
      },
    });
  }

  it('has every migration applied', () => {
    const { status, output } = prismaCli('migrate status');
    expect(status, output).toBe(0);
    expect(output).toMatch(/Database schema is up to date/);
  });

  it('matches the Prisma schema exactly (no drift)', () => {
    const { status, output } = prismaCli(
      'migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code',
    );
    expect(status, output).toBe(0);
  });

  it('enforces unique OGC IDs and emails', async () => {
    const user = await createUser();
    await expect(createUser({ ogcId: user.ogcId })).rejects.toMatchObject({ code: 'P2002' });
    await expect(createUser({ email: user.email })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces the OGC ID format and normalised emails with CHECK constraints', async () => {
    await expect(createUser({ ogcId: 'OGC000000001' })).rejects.toThrow(/users_ogc_id_format/);
    await expect(createUser({ ogcId: 'OGC12345' })).rejects.toThrow(/users_ogc_id_format/);
    await expect(createUser({ email: 'Upper@Example.test' })).rejects.toThrow(
      /users_email_normalised/,
    );
  });

  it('makes OGC IDs immutable', async () => {
    const user = await createUser();
    await expect(
      prisma.user.update({ where: { id: user.id }, data: { ogcId: 'OGC999999998' } }),
    ).rejects.toThrow(/ogc_id is immutable/);
    // Other columns remain updatable.
    await prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
  });

  it('keeps the audit log append-only', async () => {
    const event = await prisma.auditEvent.create({ data: { type: 'LOGIN_FAILED' } });
    await expect(
      prisma.auditEvent.update({ where: { id: event.id }, data: { userId: randomUUID() } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('enforces one credential per type per user', async () => {
    const user = await createUser();
    await prisma.credential.create({
      data: { userId: user.id, type: 'PASSWORD', secretHash: 'x' },
    });
    await expect(
      prisma.credential.create({ data: { userId: user.id, type: 'PASSWORD', secretHash: 'y' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps session revocation fields consistent', async () => {
    const user = await createUser();
    const device = await prisma.device.create({ data: { userId: user.id, platform: 'WEB' } });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        accessTokenHash: 'a'.repeat(64),
        accessExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await expect(
      prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
    ).rejects.toThrow(/sessions_revocation_consistent/);
  });

  it('rejects rows that reference a missing user', async () => {
    await expect(
      prisma.device.create({ data: { userId: randomUUID(), platform: 'IOS' } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('cascades deletion of a user to dependent records but keeps the audit trail', async () => {
    const user = await createUser();
    const device = await prisma.device.create({ data: { userId: user.id, platform: 'ANDROID' } });
    await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        accessTokenHash: 'c'.repeat(64),
        accessExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenHash: 'd'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.credential.create({
      data: { userId: user.id, type: 'PASSWORD', secretHash: 'x' },
    });
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: 'e'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.auditEvent.create({ data: { type: 'USER_REGISTERED', userId: user.id } });

    await prisma.user.delete({ where: { id: user.id } });

    const where = { userId: user.id };
    expect(await prisma.profile.count({ where })).toBe(0);
    expect(await prisma.credential.count({ where })).toBe(0);
    expect(await prisma.device.count({ where })).toBe(0);
    expect(await prisma.session.count({ where })).toBe(0);
    expect(await prisma.emailVerificationToken.count({ where })).toBe(0);
    expect(await prisma.auditEvent.count({ where })).toBe(1);
  });

  it('loads relations', async () => {
    const user = await createUser();
    const loaded = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { profile: true, credentials: true, devices: true, sessions: true },
    });
    expect(loaded.profile?.displayName).toBe('DB Test');
  });
});
