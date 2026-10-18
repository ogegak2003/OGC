import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { BridgeChargeView, BridgeUsageView } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { BridgeCall, BridgeTariff, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { BRIDGE_SETTINGS, type BridgeSettings } from './bridge.config.js';

/** Billable seconds: rounded up to the tariff's increment (e.g. whole minutes). */
export function billableSeconds(durationSeconds: number, incrementSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / incrementSeconds) * incrementSeconds;
}

/** Price in minor units for `seconds` at a per-minute rate (rounded up to a whole unit). */
export function priceFor(seconds: number, perMinuteMinor: number): number {
  return Math.ceil((seconds * perMinuteMinor) / 60);
}

/**
 * Provider-neutral usage ledger. Tariffs are operator configuration (never invented here):
 * without an active tariff a destination cannot be called on a live provider. Charges come
 * only from verified provider events, once per call; simulated calls are never charged.
 */
@Injectable()
export class BridgeBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(BRIDGE_SETTINGS) private readonly settings: BridgeSettings,
  ) {}

  /** The active tariff with the longest matching prefix for `e164`. */
  async tariffFor(e164: string, country: string): Promise<BridgeTariff | null> {
    const tariffs = await this.prisma.bridgeTariff.findMany({ where: { country, active: true } });
    return (
      tariffs
        .filter((t) => e164.startsWith(t.prefix))
        .sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? null
    );
  }

  /** Confirmed spend today (minor units) for the daily cap. */
  async spentToday(userId: string, now: Date): Promise<number> {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const sum = await this.prisma.bridgeUsageEntry.aggregate({
      where: { userId, createdAt: { gte: start } },
      _sum: { amountMinor: true },
    });
    return Number(sum._sum.amountMinor ?? 0n);
  }

  /** Worst-case price of a call at the maximum duration, for authorizing it in advance. */
  maxCallPrice(tariff: BridgeTariff): number {
    return priceFor(
      billableSeconds(this.settings.maxCallSeconds, tariff.billingIncrementSeconds),
      tariff.pricePerMinuteMinor,
    );
  }

  /**
   * Records the charge for a completed call, once (the external reference is unique).
   * Called inside the transaction that applies the final provider event.
   */
  async chargeCompletedCall(
    tx: Prisma.TransactionClient,
    call: BridgeCall,
    e164: string,
    durationSeconds: number,
    providerCostMinor: number | undefined,
  ): Promise<void> {
    if (call.simulated || durationSeconds <= 0) return;
    const tariff = await this.tariffFor(e164, call.country);
    if (!tariff) return; // Calls without a tariff are refused up front; nothing to charge.
    const seconds = billableSeconds(durationSeconds, tariff.billingIncrementSeconds);
    await tx.bridgeUsageEntry.createMany({
      data: [
        {
          userId: call.callerId,
          callId: call.id,
          kind: 'CHARGE',
          state: 'CONFIRMED',
          currency: tariff.currency,
          amountMinor: BigInt(priceFor(seconds, tariff.pricePerMinuteMinor)),
          providerCostMinor:
            providerCostMinor === undefined
              ? BigInt(priceFor(seconds, tariff.providerCostPerMinuteMinor))
              : BigInt(providerCostMinor),
          externalRef: `charge:call:${call.id}`,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** The charge shown with a call, if any. */
  async chargeFor(callId: string): Promise<BridgeChargeView | null> {
    const rows = await this.prisma.bridgeUsageEntry.findMany({ where: { callId } });
    if (rows.length === 0) return null;
    const currency = rows[0]?.currency ?? 'XXX';
    return {
      amountMinor: Number(rows.reduce((sum, r) => sum + r.amountMinor, 0n)),
      currency,
      state: rows.every((r) => r.state === 'CONFIRMED') ? 'confirmed' : 'estimate',
    };
  }

  async usage(userId: string, now: Date): Promise<BridgeUsageView> {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const [entries, callsToday] = await Promise.all([
      this.prisma.bridgeUsageEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.bridgeCall.count({ where: { callerId: userId, createdAt: { gte: start } } }),
    ]);
    return {
      callsToday,
      entries: entries.map((e) => ({
        id: e.id,
        callId: e.callId,
        kind: e.kind,
        amountMinor: Number(e.amountMinor),
        currency: e.currency,
        state: e.state === 'CONFIRMED' ? 'confirmed' : 'estimate',
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Auditable correction by staff: a new REFUND or ADJUSTMENT row (never an edit). The
   * reference makes a retried request a no-op.
   */
  async adjust(input: {
    staffUserId: string;
    userId: string;
    callId: string | null;
    kind: 'REFUND' | 'ADJUSTMENT';
    amountMinor: number;
    currency: string;
    reference: string;
    note: string;
  }): Promise<void> {
    if (input.kind === 'REFUND' && input.amountMinor > 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Refunds are negative.');
    }
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.bridgeUsageEntry.createMany({
        data: [
          {
            userId: input.userId,
            callId: input.callId,
            kind: input.kind,
            state: 'CONFIRMED',
            currency: input.currency,
            amountMinor: BigInt(input.amountMinor),
            externalRef: `adjust:${input.reference}`,
            note: input.note,
            createdById: input.staffUserId,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 1) {
        await this.audit.record(
          {
            type: 'BRIDGE_USAGE_ADJUSTED',
            userId: input.userId,
            details: {
              kind: input.kind,
              amountMinor: input.amountMinor,
              currency: input.currency,
              by: input.staffUserId,
            },
          },
          tx,
        );
      }
    });
  }

  /**
   * Reconciliation: calls whose recorded charge disagrees with what the provider's final
   * event implies (missing charge, duplicate, or different duration). Read-only.
   */
  async reconcile(since: Date): Promise<{ callId: string; problem: string }[]> {
    const calls = await this.prisma.bridgeCall.findMany({
      where: { simulated: false, endedAt: { gte: since } },
      include: { usage: true, number: true },
    });
    const problems: { callId: string; problem: string }[] = [];
    for (const call of calls) {
      const charges = call.usage.filter((u) => u.kind === 'CHARGE');
      if (call.status !== 'COMPLETED' && charges.length > 0) {
        problems.push({ callId: call.id, problem: `charged although ${call.status}` });
      }
      if (call.status === 'COMPLETED' && (call.durationSeconds ?? 0) > 0) {
        const tariff = await this.tariffFor(call.number.e164, call.country);
        if (tariff && charges.length === 0)
          problems.push({ callId: call.id, problem: 'missing charge' });
        if (charges.length > 1) problems.push({ callId: call.id, problem: 'duplicate charge' });
      }
    }
    return problems;
  }
}
