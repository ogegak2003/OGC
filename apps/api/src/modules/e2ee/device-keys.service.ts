import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { MlsSecurityError, inspectKeyPackage } from '@ogc/e2ee';
import type { DeviceKeyView, DirectoryDevice, OgcId, WelcomeView } from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { bytesFromBase64, bytesToBase64, ownBytes } from '../../common/bytes.js';

/** Unclaimed key packages a device may keep on the server. */
export const KEY_PACKAGE_STOCK_MAX = 200;
/**
 * Directory size per account: only the most recently registered active devices
 * are listed (and allowed in conversation groups).
 */
export const DIRECTORY_DEVICES_PER_ACCOUNT_MAX = 25;
/** Recently inactive devices listed per account, so historical commits still verify. */
export const DIRECTORY_INACTIVE_PER_ACCOUNT_MAX = 50;
/** Conversations notified in realtime when a device joins or leaves (others reconcile on open). */
const DEVICE_CHANGE_FANOUT_MAX = 200;

export interface ActiveDevice {
  deviceKeyId: string;
  deviceId: string;
  userId: string;
  ogcId: OgcId;
  signaturePublicKey: Uint8Array;
  createdAt: Date;
}

export const e2eeDeviceRequired = (): ApiException =>
  new ApiException(
    HttpStatus.CONFLICT,
    'E2EE_DEVICE_REQUIRED',
    'Set up end-to-end encryption on this device first',
  );

export const invalidMls = (message = 'Invalid encrypted data'): ApiException =>
  new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_MLS_MESSAGE', message);

/**
 * Device encryption identities (ADR-024): each signed-in device registers an
 * Ed25519 public key and publishes MLS key packages. The server stores public
 * material only and never sees private keys. A device key is active while its
 * device has a live session; logging out revokes it.
 */
@Injectable()
export class DeviceKeysService implements OnModuleInit {
  private readonly logger = new Logger(DeviceKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly realtime: RealtimePublisher,
  ) {}

  onModuleInit(): void {
    this.events.subscribe((event) => {
      if (event.type !== 'session.revoked') return;
      this.revokeForSession(event.sessionId, event.userId).catch((error: unknown) => {
        this.logger.error({ err: error }, 'Failed to revoke device key after logout');
      });
    });
  }

  /** The current device's active key, or undefined. */
  async activeKeyFor(
    auth: AuthContext,
  ): Promise<{ id: string; signaturePublicKey: Uint8Array } | undefined> {
    const key = await this.prisma.deviceKey.findFirst({
      where: { deviceId: auth.deviceId, revokedAt: null },
      select: { id: true, signaturePublicKey: true },
    });
    return key ?? undefined;
  }

  async requireActiveKey(auth: AuthContext): Promise<string> {
    const key = await this.activeKeyFor(auth);
    if (!key) throw e2eeDeviceRequired();
    return key.id;
  }

  /**
   * Registers this device's signature public key. Re-registering the same key
   * is idempotent; a different key replaces (revokes) the old one — e.g. after
   * the device lost its local key store.
   */
  async register(
    auth: AuthContext,
    signaturePublicKey: Uint8Array,
    meta: RequestMeta,
  ): Promise<DeviceKeyView> {
    const existing = await this.activeKeyFor(auth);
    if (existing && Buffer.from(existing.signaturePublicKey).equals(signaturePublicKey)) {
      return this.view(existing.id);
    }
    const id = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.deviceKey.update({
            where: { id: existing.id },
            data: { revokedAt: new Date() },
          });
          await tx.keyPackage.deleteMany({ where: { deviceKeyId: existing.id, claimedAt: null } });
          await tx.mlsWelcome.deleteMany({ where: { deviceKeyId: existing.id } });
          await this.audit.record(
            {
              type: 'DEVICE_KEY_REVOKED',
              userId: auth.userId,
              sessionId: auth.sessionId,
              meta,
              details: { reason: 'replaced' },
            },
            tx,
          );
        }
        await tx.deviceKey.create({
          data: {
            id,
            deviceId: auth.deviceId,
            userId: auth.userId,
            signaturePublicKey: ownBytes(signaturePublicKey),
          },
        });
        await this.audit.record(
          { type: 'DEVICE_KEY_REGISTERED', userId: auth.userId, sessionId: auth.sessionId, meta },
          tx,
        );
      });
    } catch (error) {
      if (
        isUniqueViolation(error, 'signature_public_key') ||
        isUniqueViolation(error, 'device_id')
      ) {
        throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'This key is already registered');
      }
      throw error;
    }
    await this.announceDeviceChange(auth.userId);
    return this.view(id);
  }

  async current(auth: AuthContext): Promise<DeviceKeyView> {
    const key = await this.activeKeyFor(auth);
    if (!key)
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'No encryption key for this device',
      );
    return this.view(key.id);
  }

  private async view(deviceKeyId: string): Promise<DeviceKeyView> {
    const keyPackagesAvailable = await this.prisma.keyPackage.count({
      where: { deviceKeyId, claimedAt: null, expiresAt: { gt: new Date() } },
    });
    return { deviceKeyId, keyPackagesAvailable };
  }

  /**
   * Stores key packages after full verification: valid signatures, the OGC
   * ciphersuite, unexpired, and a credential naming exactly this account,
   * this device key and its registered signature key.
   */
  async uploadKeyPackages(auth: AuthContext, encoded: string[]): Promise<DeviceKeyView> {
    const key = await this.activeKeyFor(auth);
    if (!key) throw e2eeDeviceRequired();
    const rows: { ref: string; data: Uint8Array<ArrayBuffer>; expiresAt: Date }[] = [];
    for (const item of encoded) {
      let inspected;
      try {
        inspected = await inspectKeyPackage(item);
      } catch (error) {
        if (error instanceof MlsSecurityError || error instanceof Error)
          throw invalidMls('Invalid key package');
        throw error;
      }
      if (
        inspected.device.ogcId !== auth.ogcId ||
        inspected.device.deviceKeyId !== key.id ||
        !Buffer.from(inspected.signaturePublicKey).equals(key.signaturePublicKey)
      ) {
        throw invalidMls('Key package does not belong to this device');
      }
      const expiresAt = new Date(Number(inspected.notAfter) * 1000);
      rows.push({ ref: inspected.ref, data: bytesFromBase64(item), expiresAt });
    }
    const stock = await this.prisma.keyPackage.count({
      where: { deviceKeyId: key.id, claimedAt: null },
    });
    if (stock + rows.length > KEY_PACKAGE_STOCK_MAX) {
      throw new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'Too many unused key packages');
    }
    await this.prisma.keyPackage.createMany({
      data: rows.map((row) => ({ ...row, deviceKeyId: key.id })),
      skipDuplicates: true,
    });
    return this.view(key.id);
  }

  /** Active devices (most recent first per account, capped) of the given accounts. */
  async activeDevices(userIds: string[]): Promise<ActiveDevice[]> {
    const now = new Date();
    const keys = await this.prisma.deviceKey.findMany({
      where: {
        userId: { in: userIds },
        revokedAt: null,
        device: { sessions: { some: { revokedAt: null, expiresAt: { gt: now } } } },
      },
      select: {
        id: true,
        deviceId: true,
        userId: true,
        signaturePublicKey: true,
        createdAt: true,
        user: { select: { ogcId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const perUser = new Map<string, number>();
    const result: ActiveDevice[] = [];
    for (const key of keys) {
      const count = perUser.get(key.userId) ?? 0;
      if (count >= DIRECTORY_DEVICES_PER_ACCOUNT_MAX) continue;
      perUser.set(key.userId, count + 1);
      result.push({
        deviceKeyId: key.id,
        deviceId: key.deviceId,
        userId: key.userId,
        ogcId: key.user.ogcId as OgcId,
        signaturePublicKey: new Uint8Array(key.signaturePublicKey),
        createdAt: key.createdAt,
      });
    }
    return result;
  }

  /**
   * The directory clients authenticate MLS members against: active devices,
   * plus the most recent inactive ones (flagged) so commits made while they
   * were active can still be verified.
   */
  async directory(userIds: string[]): Promise<DirectoryDevice[]> {
    const active = await this.activeDevices(userIds);
    const activeIds = new Set(active.map((d) => d.deviceKeyId));
    const inactive = await this.prisma.$queryRaw<
      { id: string; signature_public_key: Uint8Array; created_at: Date; ogc_id: string }[]
    >`
      SELECT k.id, k.signature_public_key, k.created_at, u.ogc_id
      FROM unnest(${userIds}::uuid[]) AS a(user_id)
      JOIN users u ON u.id = a.user_id
      CROSS JOIN LATERAL (
        SELECT dk.id, dk.signature_public_key, dk.created_at
        FROM device_keys dk
        WHERE dk.user_id = a.user_id
          AND NOT (dk.id = ANY(${[...activeIds]}::uuid[]))
        ORDER BY dk.created_at DESC
        LIMIT ${DIRECTORY_INACTIVE_PER_ACCOUNT_MAX}
      ) k`;
    return [
      ...active.map((device) => ({
        ogcId: device.ogcId,
        deviceKeyId: device.deviceKeyId,
        signaturePublicKey: bytesToBase64(device.signaturePublicKey),
        active: true,
        createdAt: device.createdAt.toISOString(),
      })),
      ...inactive.map((row) => ({
        ogcId: row.ogc_id as OgcId,
        deviceKeyId: row.id,
        signaturePublicKey: bytesToBase64(row.signature_public_key),
        active: false,
        createdAt: row.created_at.toISOString(),
      })),
    ];
  }

  /**
   * Atomically claims one unexpired key package per requested device (each
   * package is handed out once; `SKIP LOCKED` keeps concurrent claims apart).
   * Devices without stock are simply omitted.
   */
  async claim(deviceKeyIds: string[]): Promise<{ deviceKeyId: string; keyPackage: string }[]> {
    const claimed: { deviceKeyId: string; keyPackage: string }[] = [];
    for (const deviceKeyId of deviceKeyIds) {
      const rows = await this.prisma.$queryRaw<{ data: Uint8Array }[]>`
        UPDATE "key_packages" SET "claimed_at" = now()
        WHERE "id" = (
          SELECT "id" FROM "key_packages"
          WHERE "device_key_id" = ${deviceKeyId}::uuid AND "claimed_at" IS NULL AND "expires_at" > now()
          ORDER BY "id" LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "data"`;
      const row = rows[0];
      if (row) claimed.push({ deviceKeyId, keyPackage: bytesToBase64(row.data) });
    }
    return claimed;
  }

  async welcomes(auth: AuthContext): Promise<WelcomeView[]> {
    const deviceKeyId = await this.requireActiveKey(auth);
    const rows = await this.prisma.mlsWelcome.findMany({
      where: { deviceKeyId, conversation: { participants: { some: { userId: auth.userId } } } },
      orderBy: { id: 'asc' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      epoch: Number(row.epoch),
      welcome: bytesToBase64(row.data),
    }));
  }

  /** Acknowledges (deletes) a Welcome addressed to this device. Idempotent. */
  async acknowledgeWelcome(auth: AuthContext, id: string): Promise<void> {
    const deviceKeyId = await this.requireActiveKey(auth);
    await this.prisma.mlsWelcome.deleteMany({ where: { id, deviceKeyId } });
  }

  private async revokeForSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { deviceId: true },
    });
    if (!session) return;
    const { count } = await this.prisma.$transaction(async (tx) => {
      const keys = await tx.deviceKey.findMany({
        where: { deviceId: session.deviceId, revokedAt: null },
        select: { id: true },
      });
      const ids = keys.map((k) => k.id);
      await tx.keyPackage.deleteMany({ where: { deviceKeyId: { in: ids }, claimedAt: null } });
      await tx.mlsWelcome.deleteMany({ where: { deviceKeyId: { in: ids } } });
      await tx.pushToken.deleteMany({ where: { deviceId: session.deviceId } });
      const result = await tx.deviceKey.updateMany({
        where: { id: { in: ids } },
        data: { revokedAt: new Date() },
      });
      if (result.count > 0) {
        await this.audit.record(
          { type: 'DEVICE_KEY_REVOKED', userId, sessionId, details: { reason: 'session_revoked' } },
          tx,
        );
      }
      return result;
    });
    if (count > 0) await this.announceDeviceChange(userId);
  }

  /** Tells the user's recent conversation peers (and their own devices) to reconcile membership. */
  private async announceDeviceChange(userId: string): Promise<void> {
    const conversations = await this.prisma.conversationParticipant.findMany({
      where: { userId },
      select: {
        conversationId: true,
        conversation: { select: { participants: { select: { userId: true } } } },
      },
      orderBy: { conversation: { lastActivityAt: 'desc' } },
      take: DEVICE_CHANGE_FANOUT_MAX,
    });
    for (const { conversationId, conversation } of conversations) {
      this.realtime.toUsers(
        conversation.participants.map((p) => p.userId),
        'devices.changed',
        { conversationId },
      );
    }
  }
}
