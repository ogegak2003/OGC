import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccountView, OgcId, RegisterResponse } from '@ogc/types';
import type { DeviceInfo, LoginInput, RegisterInput } from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { EmailSender } from '../email/email-sender.js';
import { accountExistsEmail, verificationEmail } from '../email/templates.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  VERIFICATION_RESEND_INTERVAL_MS,
  VERIFICATION_TOKEN_TTL_MS,
} from './auth.constants.js';
import { PasswordHasher } from './password-hasher.js';
import { type CreatedSession, SessionService, canHoldSession } from './session.service.js';
import { generateSecret, hashToken } from './tokens.js';

export const REGISTER_RESPONSE: RegisterResponse = {
  verificationRequired: true,
  message: 'Check your email to verify your account and finish signing up.',
};

const invalidCredentials = (): ApiException =>
  new ApiException(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Invalid email or password');

const invalidVerificationToken = (): ApiException =>
  new ApiException(
    HttpStatus.BAD_REQUEST,
    'INVALID_VERIFICATION_TOKEN',
    'This verification link is invalid or has expired',
  );

type UserWithProfile = Prisma.UserGetPayload<{ include: { profile: true } }>;

export function toAccountView(user: UserWithProfile): AccountView {
  return {
    ogcId: user.ogcId as OgcId,
    displayName: user.profile?.displayName ?? '',
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    accountStatus: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface LoginResult {
  account: AccountView;
  session: CreatedSession;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly email: EmailSender,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get webAppUrl(): string {
    return this.config.get('WEB_APP_URL', { infer: true });
  }

  /**
   * Creates a PENDING_VERIFICATION account and emails a verification link.
   * Returns the same response whether or not the email is already registered,
   * so registration cannot be used to discover accounts.
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<RegisterResponse> {
    // Hash first on every path so both outcomes cost the same time.
    const secretHash = await this.passwords.hash(input.password);

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      await this.handleExistingEmail(existing.id, input.email, meta);
      return REGISTER_RESPONSE;
    }

    const verificationToken = generateSecret();
    try {
      const userId = await this.identity.withNewOgcId((ogcId) =>
        this.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              ogcId,
              email: input.email,
              profile: { create: { displayName: input.displayName } },
              credentials: { create: { type: 'PASSWORD', secretHash } },
              emailVerificationTokens: {
                create: {
                  tokenHash: hashToken(verificationToken),
                  expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
                },
              },
            },
            select: { id: true },
          });
          await this.audit.record({ type: 'USER_REGISTERED', userId: user.id, meta }, tx);
          return user.id;
        }),
      );
      await this.email.send(verificationEmail(input.email, this.webAppUrl, verificationToken));
      await this.audit.record({ type: 'EMAIL_VERIFICATION_SENT', userId, meta });
    } catch (error) {
      // A concurrent registration claimed the email between the check and the insert.
      if (!isUniqueViolation(error, 'email')) throw error;
      const winner = await this.prisma.user.findUniqueOrThrow({
        where: { email: input.email },
        select: { id: true },
      });
      await this.handleExistingEmail(winner.id, input.email, meta);
    }
    return REGISTER_RESPONSE;
  }

  private async handleExistingEmail(
    userId: string,
    email: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record({ type: 'REGISTRATION_EMAIL_IN_USE', userId, meta });
    await this.email.send(accountExistsEmail(email, this.webAppUrl));
  }

  /**
   * Verifies a password and opens a session. All credential failures return
   * the same error; distinct reasons are recorded only in the audit log.
   */
  async login(input: LoginInput, device: DeviceInfo, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { profile: true, credentials: { where: { type: 'PASSWORD' } } },
    });
    const credential = user?.credentials[0];

    if (!user || !credential) {
      await this.passwords.verifyAgainstDummy(input.password);
      await this.audit.record({
        type: 'LOGIN_FAILED',
        meta,
        details: { reason: 'unknown_account' },
      });
      throw invalidCredentials();
    }

    const now = Date.now();
    if (credential.lockedUntil && credential.lockedUntil.getTime() > now) {
      await this.passwords.verifyAgainstDummy(input.password);
      await this.audit.record({
        type: 'LOGIN_FAILED',
        userId: user.id,
        meta,
        details: { reason: 'locked' },
      });
      throw invalidCredentials();
    }

    if (!(await this.passwords.verify(credential.secretHash, input.password))) {
      await this.recordFailedPassword(credential.id, user.id, meta);
      throw invalidCredentials();
    }

    if (!canHoldSession(user.status)) {
      await this.audit.record({
        type: 'LOGIN_FAILED',
        userId: user.id,
        meta,
        details: { reason: 'account_unavailable', status: user.status },
      });
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'ACCOUNT_UNAVAILABLE',
        'This account is not available. Contact support for help.',
      );
    }

    const rehash = this.passwords.needsRehash(credential.secretHash)
      ? await this.passwords.hash(input.password)
      : undefined;

    const session = await this.prisma.$transaction(async (tx) => {
      await tx.credential.update({
        where: { id: credential.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastUsedAt: new Date(now),
          ...(rehash ? { secretHash: rehash } : {}),
        },
      });
      const created = await this.sessions.create(tx, user.id, device, meta);
      await this.audit.record(
        { type: 'LOGIN_SUCCEEDED', userId: user.id, sessionId: created.sessionId, meta },
        tx,
      );
      return created;
    });

    return { account: toAccountView(user), session };
  }

  private async recordFailedPassword(
    credentialId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const updated = await this.prisma.credential.update({
      where: { id: credentialId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    await this.audit.record({
      type: 'LOGIN_FAILED',
      userId,
      meta,
      details: { reason: 'invalid_password' },
    });
    if (updated.failedLoginCount >= LOCKOUT_THRESHOLD) {
      await this.prisma.credential.update({
        where: { id: credentialId },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
      });
      await this.audit.record({
        type: 'ACCOUNT_LOCKED',
        userId,
        meta,
        details: { durationMinutes: LOCKOUT_DURATION_MS / 60_000 },
      });
    }
  }

  /** Consumes a verification token and activates a pending account. */
  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, expiresAt: true, consumedAt: true },
    });
    if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
      await this.audit.record({
        type: 'EMAIL_VERIFICATION_FAILED',
        userId: record?.userId,
        meta,
        details: { reason: !record ? 'unknown_token' : record.consumedAt ? 'consumed' : 'expired' },
      });
      throw invalidVerificationToken();
    }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Guards against two concurrent uses of the same token.
      const { count } = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (count !== 1) throw invalidVerificationToken();
      // Invalidate any other outstanding tokens for this account.
      await tx.emailVerificationToken.updateMany({
        where: { userId: record.userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: now } });
      // Only pending accounts become active: verification never lifts a suspension.
      await tx.user.updateMany({
        where: { id: record.userId, status: 'PENDING_VERIFICATION' },
        data: { status: 'ACTIVE' },
      });
      await this.audit.record({ type: 'EMAIL_VERIFIED', userId: record.userId, meta }, tx);
    });
  }

  /** Sends a fresh verification link to a signed-in, unverified user. Silently rate limited. */
  async resendVerification(userId: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        emailVerificationTokens: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    if (user.emailVerifiedAt) return;
    const latest = user.emailVerificationTokens[0];
    if (latest && Date.now() - latest.createdAt.getTime() < VERIFICATION_RESEND_INTERVAL_MS) return;

    const token = generateSecret();
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.emailVerificationToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.emailVerificationToken.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
        },
      });
    });
    await this.email.send(verificationEmail(user.email, this.webAppUrl, token));
    await this.audit.record({ type: 'EMAIL_VERIFICATION_SENT', userId, meta });
    this.logger.log({ userId }, 'Verification email re-sent');
  }

  async account(userId: string): Promise<AccountView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { profile: true },
    });
    return toAccountView(user);
  }
}
