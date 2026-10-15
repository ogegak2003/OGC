import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AccountStatus, DeviceSessionView, OgcId } from '@ogc/types';
import type { DeviceInfo } from '@ogc/validation';
import { ApiException, unauthenticated } from '../../common/errors.js';
import { DomainEventBus } from '../../common/events/domain-events.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, SessionRevocationReason } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import {
  ACCESS_TOKEN_TTL_MS,
  LAST_USED_WRITE_INTERVAL_MS,
  SESSION_TTL_MS,
} from './auth.constants.js';
import type { AuthContext } from './auth-context.js';
import type { IssuedTokens } from './cookies.js';
import {
  createAccessToken,
  createRefreshToken,
  hashToken,
  hashesEqual,
  isAccessToken,
  parseRefreshToken,
} from './tokens.js';

/** Account states that may hold a session. Others are rejected and their sessions revoked. */
const SESSION_ELIGIBLE: ReadonlySet<AccountStatus> = new Set(['ACTIVE', 'PENDING_VERIFICATION']);

export function canHoldSession(status: AccountStatus): boolean {
  return SESSION_ELIGIBLE.has(status);
}

export interface CreatedSession extends IssuedTokens {
  sessionId: string;
  deviceId: string;
}

export interface RefreshedSession extends IssuedTokens {
  sessionId: string;
  userId: string;
}

const accountUnavailable = (): ApiException =>
  new ApiException(HttpStatus.UNAUTHORIZED, 'ACCOUNT_UNAVAILABLE', 'This account is not available');

/**
 * Owns device and session records: creation, per-request authentication,
 * refresh-token rotation with reuse detection, and revocation.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  /** Creates a device and a session for it. Must run inside the caller's transaction. */
  async create(
    tx: Prisma.TransactionClient,
    userId: string,
    device: DeviceInfo,
    meta: RequestMeta,
  ): Promise<CreatedSession> {
    const now = Date.now();
    const accessToken = createAccessToken();
    const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_MS);
    const expiresAt = new Date(now + SESSION_TTL_MS);

    const createdDevice = await tx.device.create({
      data: { userId, platform: device.platform, name: device.name ?? null },
    });
    // Random (v4) session id: it is embedded in refresh tokens, so it should not reveal time.
    const sessionId = randomUUID();
    const refreshToken = createRefreshToken(sessionId);
    const session = await tx.session.create({
      data: {
        id: sessionId,
        userId,
        deviceId: createdDevice.id,
        accessTokenHash: hashToken(accessToken),
        accessExpiresAt,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt,
      },
    });
    await this.audit.record({ type: 'SESSION_CREATED', userId, sessionId: session.id, meta }, tx);

    return {
      sessionId: session.id,
      deviceId: createdDevice.id,
      accessToken,
      refreshToken,
      accessExpiresAt,
      expiresAt,
    };
  }

  /** Resolves an access token to its verified identity, or throws 401. */
  async authenticate(accessToken: string, via: AuthContext['via']): Promise<AuthContext> {
    if (!isAccessToken(accessToken)) throw unauthenticated();
    const session = await this.prisma.session.findUnique({
      where: { accessTokenHash: hashToken(accessToken) },
      include: {
        user: { select: { ogcId: true, status: true, staffRoles: { select: { role: true } } } },
      },
    });
    const now = Date.now();
    if (
      !session ||
      session.revokedAt ||
      session.accessExpiresAt.getTime() <= now ||
      session.expiresAt.getTime() <= now
    ) {
      throw unauthenticated();
    }
    if (!canHoldSession(session.user.status)) {
      await this.revoke(session.id, session.userId, 'ACCOUNT_DISABLED', {});
      throw accountUnavailable();
    }
    if (now - session.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
      const lastUsedAt = new Date(now);
      await this.prisma.$transaction([
        this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt } }),
        this.prisma.device.update({
          where: { id: session.deviceId },
          data: { lastSeenAt: lastUsedAt },
        }),
      ]);
    }
    return {
      userId: session.userId,
      ogcId: session.user.ogcId as OgcId,
      accountStatus: session.user.status,
      sessionId: session.id,
      deviceId: session.deviceId,
      accessExpiresAt: session.accessExpiresAt,
      via,
      staffRoles: session.user.staffRoles.map((assignment) => assignment.role),
    };
  }

  /**
   * Exchanges a refresh token for new access and refresh tokens (rotation).
   * Presenting a token that was already rotated away revokes the session.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<RefreshedSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw unauthenticated();
    const session = await this.prisma.session.findUnique({
      where: { id: parsed.sessionId },
      include: { user: { select: { status: true } } },
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now) {
      throw unauthenticated();
    }

    const presentedHash = hashToken(refreshToken);
    if (!hashesEqual(presentedHash, session.refreshTokenHash)) {
      await this.audit.record({
        type: 'REFRESH_TOKEN_REUSE_DETECTED',
        userId: session.userId,
        sessionId: session.id,
        meta,
      });
      await this.revoke(session.id, session.userId, 'REFRESH_TOKEN_REUSE', meta);
      throw unauthenticated();
    }
    if (!canHoldSession(session.user.status)) {
      await this.revoke(session.id, session.userId, 'ACCOUNT_DISABLED', meta);
      throw accountUnavailable();
    }

    const accessToken = createAccessToken();
    const nextRefreshToken = createRefreshToken(session.id);
    const accessExpiresAt = new Date(
      Math.min(now + ACCESS_TOKEN_TTL_MS, session.expiresAt.getTime()),
    );
    // Compare-and-swap on the old hash: of two concurrent refreshes, only one wins.
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: {
        accessTokenHash: hashToken(accessToken),
        accessExpiresAt,
        refreshTokenHash: hashToken(nextRefreshToken),
        lastUsedAt: new Date(now),
      },
    });
    if (count !== 1) throw unauthenticated();
    await this.audit.record({
      type: 'SESSION_REFRESHED',
      userId: session.userId,
      sessionId: session.id,
      meta,
    });

    return {
      sessionId: session.id,
      userId: session.userId,
      accessToken,
      refreshToken: nextRefreshToken,
      accessExpiresAt,
      expiresAt: session.expiresAt,
    };
  }

  /** Revokes one session. Idempotent. */
  async revoke(
    sessionId: string,
    userId: string,
    reason: SessionRevocationReason,
    meta: RequestMeta,
  ): Promise<void> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
    if (count === 1) {
      await this.audit.record({
        type: 'SESSION_REVOKED',
        userId,
        sessionId,
        meta,
        details: { reason },
      });
      this.events.publish({ type: 'session.revoked', sessionId, userId });
    }
  }

  /** The account's signed-in devices (active sessions), newest activity first. */
  async list(userId: string, currentSessionId: string): Promise<DeviceSessionView[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        device: { select: { platform: true, name: true } },
      },
      take: 100,
    });
    return sessions.map((s) => ({
      id: s.id,
      platform: s.device.platform,
      deviceName: s.device.name,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === currentSessionId,
    }));
  }

  /**
   * Signs out one of the caller's own sessions (e.g. a lost phone). Someone else's session
   * gets the same 404 as an unknown ID. Revocation closes its sockets and removes the
   * device's encryption keys and push token (session.revoked listeners).
   */
  async revokeOwn(
    userId: string,
    sessionId: string,
    currentSessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
      select: { id: true },
    });
    if (!session) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Session not found');
    }
    await this.revoke(
      session.id,
      userId,
      session.id === currentSessionId ? 'LOGOUT' : 'USER_REVOKED',
      meta,
    );
  }

  /** Ends every active session of the account (password reset); returns how many. */
  async revokeAll(
    userId: string,
    reason: SessionRevocationReason,
    meta: RequestMeta,
  ): Promise<number> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    for (const session of sessions) await this.revoke(session.id, userId, reason, meta);
    return sessions.length;
  }

  /** Ends every other active session of the account; returns how many. */
  async revokeOthers(
    userId: string,
    keepSessionId: string,
    reason: SessionRevocationReason,
    meta: RequestMeta,
  ): Promise<number> {
    const others = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, id: { not: keepSessionId } },
      select: { id: true },
    });
    for (const other of others) await this.revoke(other.id, userId, reason, meta);
    return others.length;
  }

  async describe(sessionId: string): Promise<{ accessExpiresAt: Date; expiresAt: Date }> {
    return this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { accessExpiresAt: true, expiresAt: true },
    });
  }
}
