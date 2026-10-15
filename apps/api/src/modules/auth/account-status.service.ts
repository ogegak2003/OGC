import { HttpStatus, Injectable } from '@nestjs/common';
import type { AccountStatus } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from './auth-context.js';
import { SessionService } from './session.service.js';

const notFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Account not found');

/**
 * Staff-only account suspension (no self-service control exists). Suspending ends every
 * session at once — API access, refresh, and open realtime connections (`session.revoked`) —
 * instead of waiting for access tokens to expire. As on any sign-out, the devices' MLS keys
 * and push tokens are removed, so a suspended account stops receiving new messages; its
 * account record, contacts and server-side history are kept. Reinstating only lifts the
 * suspension: the person signs in again and devices set up encryption again.
 */
@Injectable()
export class AccountStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async suspend(
    actor: AuthContext,
    ogcId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ status: AccountStatus; sessionsEnded: number }> {
    const user = await this.prisma.user.findUnique({
      where: { ogcId },
      select: { id: true, status: true },
    });
    if (!user) throw notFound();
    if (user.id === actor.userId) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Staff cannot suspend their own account',
      );
    }
    // Compare-and-set: only an active or pending account becomes suspended (idempotent).
    const { count } = await this.prisma.user.updateMany({
      where: { id: user.id, status: { in: ['ACTIVE', 'PENDING_VERIFICATION'] } },
      data: { status: 'SUSPENDED' },
    });
    if (count === 1) {
      await this.audit.record({
        type: 'ACCOUNT_SUSPENDED',
        userId: user.id,
        sessionId: actor.sessionId,
        meta,
        details: { actor: actor.ogcId, reason },
      });
    }
    // Always end sessions, also on a repeated call (e.g. after a status set directly in SQL).
    const sessionsEnded = await this.sessions.revokeAll(user.id, 'ACCOUNT_DISABLED', meta);
    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { status: true },
    });
    return { status: current.status, sessionsEnded };
  }

  async reinstate(
    actor: AuthContext,
    ogcId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ status: AccountStatus }> {
    const user = await this.prisma.user.findUnique({
      where: { ogcId },
      select: { id: true, emailVerifiedAt: true },
    });
    if (!user) throw notFound();
    const { count } = await this.prisma.user.updateMany({
      where: { id: user.id, status: 'SUSPENDED' },
      data: { status: user.emailVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION' },
    });
    if (count === 1) {
      await this.audit.record({
        type: 'ACCOUNT_REINSTATED',
        userId: user.id,
        sessionId: actor.sessionId,
        meta,
        details: { actor: actor.ogcId, reason },
      });
    }
    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { status: true },
    });
    return { status: current.status };
  }
}
