import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { BridgeNumberView, BridgeStatusView, BridgeVerificationView } from '@ogc/types';
import {
  type BridgeConfirmVerification,
  type BridgeStartVerification,
  bridgeCountry,
  maskPhoneNumber,
  normalizePhoneNumber,
} from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { BridgeNumber, BridgeVerification } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import {
  BRIDGE_SETTINGS,
  type BridgeSettings,
  CODE_MAX_ATTEMPTS,
  CODE_RESEND_MS,
  CODE_TTL_MS,
  CODES_PER_NUMBER_PER_DAY,
  VERIFICATIONS_PER_ACCOUNT_PER_DAY,
} from './bridge.config.js';
import { canReceiveCodes } from './destination-rules.js';
import { BRIDGE_PROVIDER, type BridgeProvider } from './provider/bridge-provider.js';

const DAY = 86_400_000;

export const bridgeDisabled = (): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'BRIDGE_DISABLED', 'OGC Bridge is not available.');
export const bridgeNotConfigured = (): ApiException =>
  new ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    'BRIDGE_NOT_CONFIGURED',
    'Calls to telephone numbers are not set up on this server yet.',
  );

/**
 * Linking a telephone number to an OGC account (Bridge), proven by a one-time code sent to the
 * number. Never reveals which account holds a number, never stores or logs a code, and never
 * treats caller ID as proof of ownership.
 */
@Injectable()
export class BridgeNumbersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(BRIDGE_SETTINGS) private readonly settings: BridgeSettings,
    @Inject(BRIDGE_PROVIDER) private readonly provider: BridgeProvider,
  ) {}

  /** Whether Bridge can be used at all (flag on and a provider configured). */
  requireUsable(): void {
    if (!this.settings.enabled) throw bridgeDisabled();
    if (this.provider.name === 'disabled') throw bridgeNotConfigured();
  }

  async status(userId: string): Promise<BridgeStatusView> {
    const limits = {
      maxCallSeconds: this.settings.maxCallSeconds,
      callsPerDay: this.settings.callsPerDay,
      concurrentCalls: this.settings.concurrentCalls,
    };
    if (!this.settings.enabled) {
      return {
        enabled: false,
        provider: 'disabled',
        liveDialing: false,
        countries: [],
        number: null,
        verification: null,
        limits,
      };
    }
    const [number, verification] = await Promise.all([
      this.activeNumber(userId),
      this.prisma.bridgeVerification.findFirst({
        where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      enabled: true,
      provider: this.provider.name,
      liveDialing: this.provider.live,
      countries: this.settings.countries.flatMap((code) => {
        const country = bridgeCountry(code);
        return country ? [country] : [];
      }),
      number: number ? numberView(number) : null,
      verification: verification ? this.verificationView(verification) : null,
      limits,
    };
  }

  activeNumber(userId: string): Promise<BridgeNumber | null> {
    return this.prisma.bridgeNumber.findFirst({ where: { userId, revokedAt: null } });
  }

  /**
   * Sends a code to the number. Answers identically whether or not the number is linked to
   * another account (no enumeration); possession is settled when the code is confirmed.
   */
  async startVerification(
    userId: string,
    input: BridgeStartVerification,
    meta: RequestMeta,
  ): Promise<BridgeVerificationView> {
    this.requireUsable();
    if (!this.settings.countries.includes(input.country)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PHONE_NUMBER_INVALID',
        'OGC Bridge is not available in that country yet.',
      );
    }
    const normalized = normalizePhoneNumber(input.number, input.country);
    if (!normalized.ok) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PHONE_NUMBER_INVALID',
        normalized.reason === 'WRONG_COUNTRY'
          ? 'That number belongs to a different country.'
          : 'That is not a valid phone number for the selected country.',
      );
    }
    const { e164 } = normalized;
    if (!canReceiveCodes(e164)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PHONE_NUMBER_INVALID',
        'Use a mobile number that can receive text messages.',
      );
    }
    const now = new Date();
    const dayAgo = new Date(now.getTime() - DAY);

    // Resend: the same number with a verification still open reuses it (after a cooldown).
    const open = await this.prisma.bridgeVerification.findFirst({
      where: { userId, e164, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (open && now.getTime() - open.lastSentAt.getTime() < CODE_RESEND_MS) {
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'RESEND_TOO_SOON',
        'Wait a minute before asking for another code.',
      );
    }
    const [sentToNumber, startedByAccount] = await Promise.all([
      this.prisma.bridgeVerification.aggregate({
        where: { e164, lastSentAt: { gt: dayAgo } },
        _sum: { sends: true },
      }),
      this.prisma.bridgeVerification.count({ where: { userId, createdAt: { gt: dayAgo } } }),
    ]);
    if (
      (sentToNumber._sum.sends ?? 0) >= CODES_PER_NUMBER_PER_DAY ||
      (!open && startedByAccount >= VERIFICATIONS_PER_ACCOUNT_PER_DAY)
    ) {
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many codes were requested today. Try again tomorrow.',
      );
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const verification = open
      ? await this.prisma.bridgeVerification.update({
          where: { id: open.id },
          data: {
            codeHash: this.hash(open.id, code),
            sends: { increment: 1 },
            lastSentAt: now,
            attempts: 0,
            expiresAt: new Date(now.getTime() + CODE_TTL_MS),
          },
        })
      : await this.createVerification(userId, e164, input.country, code, now);

    try {
      await this.provider.sendVerificationCode(e164, code);
    } catch {
      // Not delivered: make this code unusable rather than leave a code nobody received.
      await this.prisma.bridgeVerification.update({
        where: { id: verification.id },
        data: { expiresAt: now },
      });
      throw bridgeNotConfigured();
    }
    await this.audit.record({
      type: 'BRIDGE_VERIFICATION_STARTED',
      userId,
      meta,
      details: { country: input.country, delivery: verification.delivery, resend: Boolean(open) },
    });
    return this.verificationView(verification);
  }

  private async createVerification(
    userId: string,
    e164: string,
    country: string,
    code: string,
    now: Date,
  ): Promise<BridgeVerification> {
    // The hash binds the code to its verification ID, so the ID is created first.
    const row = await this.prisma.bridgeVerification.create({
      data: {
        userId,
        e164,
        country,
        codeHash: '0'.repeat(64),
        delivery: this.provider.codeDelivery,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        lastSentAt: now,
      },
    });
    return this.prisma.bridgeVerification.update({
      where: { id: row.id },
      data: { codeHash: this.hash(row.id, code) },
    });
  }

  /** Confirms possession. A correct code links the number (revoking any stale link of it). */
  async confirmVerification(
    userId: string,
    input: BridgeConfirmVerification,
    meta: RequestMeta,
  ): Promise<BridgeNumberView> {
    this.requireUsable();
    const verification = await this.prisma.bridgeVerification.findFirst({
      where: { id: input.verificationId, userId },
    });
    const now = new Date();
    if (!verification || verification.consumedAt) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'VERIFICATION_FAILED', 'Request a new code.');
    }
    if (verification.expiresAt <= now) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VERIFICATION_EXPIRED',
        'That code has expired. Request a new one.',
      );
    }
    if (verification.attempts >= CODE_MAX_ATTEMPTS) {
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many wrong codes. Request a new one.',
      );
    }
    // Count the attempt before comparing (concurrent guesses cannot exceed the limit).
    const counted = await this.prisma.bridgeVerification.updateMany({
      where: { id: verification.id, attempts: { lt: CODE_MAX_ATTEMPTS }, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) {
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many wrong codes. Request a new one.',
      );
    }
    const expected = Buffer.from(verification.codeHash, 'hex');
    const given = Buffer.from(this.hash(verification.id, input.code), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await this.audit.record({
        type: 'BRIDGE_VERIFICATION_FAILED',
        userId,
        meta,
        details: { attempt: verification.attempts + 1 },
      });
      const remaining = CODE_MAX_ATTEMPTS - verification.attempts - 1;
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VERIFICATION_FAILED',
        remaining > 0
          ? `That code is not correct. ${String(remaining)} ${remaining === 1 ? 'try' : 'tries'} left.`
          : 'That code is not correct. Request a new one.',
      );
    }

    const linked = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.bridgeVerification.updateMany({
        where: { id: verification.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'VERIFICATION_FAILED',
          'Request a new code.',
        );
      }
      // This account's previous number, and any stale link of this number elsewhere (a
      // recycled or transferred number): possession, just proven, wins.
      const replaced = await tx.bridgeNumber.findMany({
        where: {
          revokedAt: null,
          OR: [{ userId }, { e164: verification.e164 }],
        },
        select: { id: true, userId: true },
      });
      if (replaced.length > 0) {
        await tx.bridgeNumber.updateMany({
          where: { id: { in: replaced.map((r) => r.id) } },
          data: { status: 'REVOKED', revokedAt: now, revocationReason: 'REPLACED' },
        });
      }
      for (const old of replaced.filter((r) => r.userId !== userId)) {
        await this.audit.record(
          { type: 'BRIDGE_NUMBER_UNLINKED', userId: old.userId, details: { reason: 'REPLACED' } },
          tx,
        );
      }
      const created = await tx.bridgeNumber.create({
        data: {
          userId,
          e164: verification.e164,
          country: verification.country,
          consentedAt: verification.createdAt,
          verifiedAt: now,
        },
      });
      await this.audit.record(
        {
          type: 'BRIDGE_NUMBER_VERIFIED',
          userId,
          meta,
          details: {
            country: verification.country,
            replacedOwn: replaced.some((r) => r.userId === userId),
          },
        },
        tx,
      );
      return created;
    });
    return numberView(linked);
  }

  async setPreferences(userId: string, allowContactCalls: boolean): Promise<BridgeNumberView> {
    this.requireUsable();
    const number = await this.activeNumber(userId);
    if (!number) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No linked number.');
    }
    return numberView(
      await this.prisma.bridgeNumber.update({
        where: { id: number.id },
        data: { allowContactCalls },
      }),
    );
  }

  /** Unlinks the number at once. Works even when Bridge is switched off (people can leave). */
  async unlink(userId: string, meta: RequestMeta): Promise<void> {
    const updated = await this.prisma.bridgeNumber.updateMany({
      where: { userId, revokedAt: null },
      data: { status: 'REVOKED', revokedAt: new Date(), revocationReason: 'UNLINKED' },
    });
    if (updated.count === 0) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No linked number.');
    }
    await this.audit.record({
      type: 'BRIDGE_NUMBER_UNLINKED',
      userId,
      meta,
      details: { reason: 'UNLINKED' },
    });
  }

  private verificationView(v: BridgeVerification): BridgeVerificationView {
    return {
      id: v.id,
      delivery: v.delivery === 'simulated' ? 'simulated' : 'sms',
      expiresAt: v.expiresAt.toISOString(),
      resendAvailableAt: new Date(v.lastSentAt.getTime() + CODE_RESEND_MS).toISOString(),
      attemptsRemaining: Math.max(0, CODE_MAX_ATTEMPTS - v.attempts),
    };
  }

  private hash(verificationId: string, code: string): string {
    return createHmac('sha256', this.settings.codeSecret)
      .update(`${verificationId}:${code}`)
      .digest('hex');
  }
}

export function numberView(n: BridgeNumber): BridgeNumberView {
  return {
    id: n.id,
    country: n.country,
    maskedNumber: maskPhoneNumber(n.e164),
    status: n.status,
    verifiedAt: n.verifiedAt.toISOString(),
    allowContactCalls: n.allowContactCalls,
  };
}
