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

describe('social graph constraints', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.prisma;
  });

  afterAll(async () => {
    await t.close();
  });

  const user = () =>
    prisma.user.create({
      data: {
        ogcId: `OGC${String(randomInt(100_000_000, 1_000_000_000))}`,
        email: uniqueEmail(),
        profile: { create: { displayName: 'Graph Test' } },
      },
    });

  it('gives new profiles privacy-leaning defaults', async () => {
    const u = await user();
    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: u.id } });
    expect(profile).toMatchObject({
      profileVisibility: 'CONTACTS',
      discoverable: true,
      contactRequestPolicy: 'EVERYONE',
      bio: null,
      avatarKey: null,
    });
  });

  it('rejects self-relationships of every kind', async () => {
    const u = await user();
    await expect(
      prisma.contactRequest.create({ data: { senderId: u.id, recipientId: u.id } }),
    ).rejects.toThrow(/contact_requests_not_self/);
    await expect(
      prisma.contact.create({ data: { ownerId: u.id, contactId: u.id } }),
    ).rejects.toThrow(/contacts_not_self/);
    await expect(
      prisma.block.create({ data: { blockerId: u.id, blockedId: u.id } }),
    ).rejects.toThrow(/blocks_not_self/);
    await expect(
      prisma.userReport.create({
        data: { reporterId: u.id, reportedUserId: u.id, category: 'SPAM' },
      }),
    ).rejects.toThrow(/user_reports_not_self/);
  });

  it('allows only one pending request per pair, in either direction', async () => {
    const [a, b] = [await user(), await user()];
    await prisma.contactRequest.create({ data: { senderId: a.id, recipientId: b.id } });
    await expect(
      prisma.contactRequest.create({ data: { senderId: a.id, recipientId: b.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.contactRequest.create({ data: { senderId: b.id, recipientId: a.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Answered requests do not count: a new request is possible afterwards.
    await prisma.contactRequest.updateMany({
      where: { senderId: a.id },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    await prisma.contactRequest.create({ data: { senderId: b.id, recipientId: a.id } });
  });

  it('keeps request status and response time consistent', async () => {
    const [a, b] = [await user(), await user()];
    const req = await prisma.contactRequest.create({ data: { senderId: a.id, recipientId: b.id } });
    await expect(
      prisma.contactRequest.update({ where: { id: req.id }, data: { status: 'ACCEPTED' } }),
    ).rejects.toThrow(/contact_requests_response_consistent/);
  });

  it('prevents duplicate contacts, blocks and open reports', async () => {
    const [a, b] = [await user(), await user()];
    await prisma.contact.create({ data: { ownerId: a.id, contactId: b.id } });
    await expect(
      prisma.contact.create({ data: { ownerId: a.id, contactId: b.id } }),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
    await prisma.block.create({ data: { blockerId: a.id, blockedId: b.id } });
    await expect(
      prisma.block.create({ data: { blockerId: a.id, blockedId: b.id } }),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
    await prisma.userReport.create({
      data: { reporterId: a.id, reportedUserId: b.id, category: 'SPAM' },
    });
    await expect(
      prisma.userReport.create({
        data: { reporterId: a.id, reportedUserId: b.id, category: 'SPAM' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('accepts only server-generated avatar keys', async () => {
    const u = await user();
    for (const bad of ['../../etc/passwd', 'avatars/photo.webp', `avatars/${randomUUID()}.exe`]) {
      await expect(
        prisma.profile.update({ where: { userId: u.id }, data: { avatarKey: bad } }),
      ).rejects.toThrow(/profiles_avatar_key_format/);
    }
  });

  it('cascades user deletion to relationships but keeps reports for moderators', async () => {
    const [a, b] = [await user(), await user()];
    await prisma.contact.create({ data: { ownerId: a.id, contactId: b.id } });
    await prisma.block.create({ data: { blockerId: b.id, blockedId: a.id } });
    await prisma.contactRequest.create({ data: { senderId: b.id, recipientId: a.id } });
    await prisma.staffRoleAssignment.create({ data: { userId: a.id, role: 'MODERATOR' } });
    const report = await prisma.userReport.create({
      data: { reporterId: b.id, reportedUserId: a.id, category: 'SPAM' },
    });

    await prisma.user.delete({ where: { id: a.id } });

    expect(
      await prisma.contact.count({ where: { OR: [{ ownerId: a.id }, { contactId: a.id }] } }),
    ).toBe(0);
    expect(await prisma.block.count({ where: { blockedId: a.id } })).toBe(0);
    expect(await prisma.contactRequest.count({ where: { recipientId: a.id } })).toBe(0);
    expect(await prisma.staffRoleAssignment.count({ where: { userId: a.id } })).toBe(0);
    const kept = await prisma.userReport.findUniqueOrThrow({ where: { id: report.id } });
    expect(kept).toMatchObject({ reporterId: b.id, reportedUserId: null });
  });
});

describe('messaging constraints', () => {
  let t: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    t = await createTestApp();
    prisma = t.prisma;
  });

  afterAll(async () => {
    await t.close();
  });

  const user = () =>
    prisma.user.create({
      data: {
        ogcId: `OGC${String(randomInt(100_000_000, 1_000_000_000))}`,
        email: uniqueEmail(),
        profile: { create: { displayName: 'Messaging Test' } },
      },
    });

  async function direct() {
    const [a, b] = [await user(), await user()];
    const conversation = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        type: 'DIRECT',
        directKey: [a.id, b.id].sort().join(':'),
        participants: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    });
    return { a, b, conversation };
  }

  const message = (
    conversationId: string,
    senderId: string,
    seq: number,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.message.create({
      data: {
        conversationId,
        senderId,
        seq: BigInt(seq),
        version: BigInt(seq),
        clientMessageId: randomUUID(),
        epoch: 1n,
        ciphertext: new Uint8Array([1, 2, 3]),
        ...extra,
      },
    });

  it('allows exactly one DIRECT conversation per pair of users', async () => {
    const { a, b } = await direct();
    await expect(
      prisma.conversation.create({
        data: { id: randomUUID(), type: 'DIRECT', directKey: [a.id, b.id].sort().join(':') },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // The key must be the ordered pair; DIRECT conversations must have one.
    await expect(
      prisma.conversation.create({
        data: {
          id: randomUUID(),
          type: 'DIRECT',
          directKey: [a.id, b.id].sort().reverse().join(':'),
        },
      }),
    ).rejects.toThrow(/conversations_direct_key_format/);
    await expect(
      prisma.conversation.create({ data: { id: randomUUID(), type: 'DIRECT' } }),
    ).rejects.toThrow(/conversations_direct_key_consistent/);
  });

  it('admits only the two named users as participants of a DIRECT conversation', async () => {
    const { conversation } = await direct();
    const outsider = await user();
    await expect(
      prisma.conversationParticipant.create({
        data: { conversationId: conversation.id, userId: outsider.id },
      }),
    ).rejects.toThrow(/not part of this direct conversation/);
  });

  it('orders messages uniquely and deduplicates client submissions', async () => {
    const { a, conversation } = await direct();
    const first = await message(conversation.id, a.id, 1);
    await expect(message(conversation.id, a.id, 1)).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      message(conversation.id, a.id, 2, { clientMessageId: first.clientMessageId }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(message(conversation.id, a.id, 0)).rejects.toThrow(/messages_ordering/);
  });

  it('prevents replies across conversations', async () => {
    const one = await direct();
    const two = await direct();
    const target = await message(one.conversation.id, one.a.id, 1);
    await expect(
      message(two.conversation.id, two.a.id, 1, { replyToId: target.id }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      message(one.conversation.id, one.a.id, 2, { replyToId: target.id }),
    ).resolves.toBeDefined();
  });

  it('keeps deletion and edit metadata consistent and bounds ciphertext size', async () => {
    const { a, conversation } = await direct();
    await expect(message(conversation.id, a.id, 1, { deletedAt: new Date() })).rejects.toThrow(
      /messages_deleted_consistent/,
    );
    await expect(message(conversation.id, a.id, 2, { ciphertext: null })).rejects.toThrow(
      /messages_deleted_consistent/,
    );
    await expect(message(conversation.id, a.id, 3, { revision: 1 })).rejects.toThrow(
      /messages_edit_consistent/,
    );
    await expect(
      message(conversation.id, a.id, 4, { ciphertext: new Uint8Array(65_537) }),
    ).rejects.toThrow(/messages_ciphertext_size/);
  });

  it('accepts only the fixed reaction set, once per user and type', async () => {
    const { a, conversation } = await direct();
    const m = await message(conversation.id, a.id, 1);
    await prisma.messageReaction.create({
      data: { messageId: m.id, userId: a.id, reaction: 'heart' },
    });
    await expect(
      prisma.messageReaction.create({ data: { messageId: m.id, userId: a.id, reaction: 'heart' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.messageReaction.create({
        data: { messageId: m.id, userId: a.id, reaction: '<script>' },
      }),
    ).rejects.toThrow(/message_reactions_allowed/);
  });

  it('accepts one MLS commit per epoch', async () => {
    const { conversation } = await direct();
    await prisma.mlsCommit.create({
      data: { conversationId: conversation.id, epoch: 0n, version: 1n, data: new Uint8Array([1]) },
    });
    await expect(
      prisma.mlsCommit.create({
        data: {
          conversationId: conversation.id,
          epoch: 0n,
          version: 2n,
          data: new Uint8Array([2]),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows one active encryption key per device, 32-byte keys, unique across devices', async () => {
    const owner = await user();
    const device = await prisma.device.create({ data: { userId: owner.id, platform: 'WEB' } });
    const key = new Uint8Array(32).fill(9);
    await prisma.deviceKey.create({
      data: { id: randomUUID(), deviceId: device.id, userId: owner.id, signaturePublicKey: key },
    });
    await expect(
      prisma.deviceKey.create({
        data: {
          id: randomUUID(),
          deviceId: device.id,
          userId: owner.id,
          signaturePublicKey: new Uint8Array(32).fill(8),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.deviceKey.create({
        data: {
          id: randomUUID(),
          deviceId: device.id,
          userId: owner.id,
          signaturePublicKey: new Uint8Array(31),
          revokedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/device_keys_signature_key_length/);
    const other = await prisma.device.create({ data: { userId: owner.id, platform: 'IOS' } });
    await expect(
      prisma.deviceKey.create({
        data: { id: randomUUID(), deviceId: other.id, userId: owner.id, signaturePublicKey: key },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('accepts only server-generated attachment storage keys', async () => {
    const { a, conversation } = await direct();
    const attachment = (storageKey: string) =>
      prisma.attachment.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          uploaderId: a.id,
          kind: 'FILE',
          size: 10,
          sha256: new Uint8Array(32),
          storageKey,
        },
      });
    await expect(attachment('attachments/../../etc/passwd')).rejects.toThrow(
      /attachments_storage_key_format/,
    );
    await expect(attachment('attachments/photo.jpg')).rejects.toThrow(
      /attachments_storage_key_format/,
    );
    await expect(attachment(`attachments/${randomUUID()}.bin`)).resolves.toBeDefined();
  });
});
