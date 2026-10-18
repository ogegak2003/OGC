import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  BridgeCallView,
  BridgeEligibilityView,
  BridgeIneligibleReason,
  OgcId,
} from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { BridgeCall, BridgeCallStatus, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import { BridgeBillingService } from './bridge-billing.service.js';
import { BRIDGE_SETTINGS, type BridgeSettings } from './bridge.config.js';
import { BridgeNumbersService, bridgeNotConfigured } from './bridge-numbers.service.js';
import { checkDestination } from './destination-rules.js';
import {
  BRIDGE_PROVIDER,
  type BridgeProvider,
  type ProviderCallEvent,
} from './provider/bridge-provider.js';

const ACTIVE: BridgeCallStatus[] = ['REQUESTED', 'RINGING', 'ANSWERED'];
const FINAL: BridgeCallStatus[] = [
  'COMPLETED',
  'BUSY',
  'NO_ANSWER',
  'REJECTED',
  'FAILED',
  'CANCELED',
];
/** Progress order; final states rank highest and can never be left. */
const RANK: Record<BridgeCallStatus, number> = {
  REQUESTED: 0,
  RINGING: 1,
  ANSWERED: 2,
  COMPLETED: 3,
  BUSY: 3,
  NO_ANSWER: 3,
  REJECTED: 3,
  FAILED: 3,
  CANCELED: 3,
};
const PROVIDER_TIMEOUT_MS = 10_000;
/** A call with no provider news for this long is reconciled with the provider. */
const STALE_MS = 2 * 60_000;
const SWEEP_MS = 15_000;

const REASON_TEXT: Record<string, string> = {
  PROVIDER_UNAVAILABLE: 'The telephone network provider could not be reached.',
  NO_PROVIDER_UPDATE: 'The provider stopped reporting on this call.',
  MAX_DURATION: 'The call reached the maximum length.',
  CANCELED_BY_CALLER: 'You cancelled the call.',
};

const notEligible = (reason: BridgeIneligibleReason): ApiException =>
  new ApiException(
    reason === 'LIMIT_REACHED' ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.FORBIDDEN,
    reason === 'LIMIT_REACHED' ? 'BRIDGE_LIMIT_REACHED' : 'BRIDGE_NOT_ELIGIBLE',
    reason === 'LIMIT_REACHED'
      ? 'You have reached your OGC Bridge limit for now.'
      : reason === 'NOT_A_CONTACT'
        ? 'You can call only your contacts through OGC Bridge.'
        : reason === 'CALLER_NUMBER_REQUIRED'
          ? 'Link and verify your own phone number first: OGC Bridge rings it to connect you.'
          : 'This person cannot be called through OGC Bridge.',
  );

/**
 * Bridge calls from the OGC app to a contact's verified telephone number, through the provider.
 * Separate from OGC-to-OGC calls. State changes only on authenticated provider events; prices,
 * durations and statuses from clients are never accepted.
 */
@Injectable()
export class BridgeCallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BridgeCallsService.name);
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly relationships: RelationshipService,
    private readonly numbers: BridgeNumbersService,
    private readonly billing: BridgeBillingService,
    @Inject(BRIDGE_SETTINGS) private readonly settings: BridgeSettings,
    @Inject(BRIDGE_PROVIDER) private readonly provider: BridgeProvider,
  ) {}

  onModuleInit(): void {
    if (!this.settings.enabled || this.provider.name === 'disabled') return;
    this.sweeper = setInterval(() => {
      void this.sweep(new Date()).catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error.name : 'unknown' },
          'Bridge sweep failed',
        );
      });
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** Whether the caller could call this person now (no detail that reveals a number). */
  async eligibility(callerId: string, ogcId: OgcId, now: Date): Promise<BridgeEligibilityView> {
    if (!this.settings.enabled) return { eligible: false, reason: 'BRIDGE_DISABLED' };
    if (this.provider.name === 'disabled') return { eligible: false, reason: 'NOT_CONFIGURED' };
    const result = await this.check(callerId, ogcId, now);
    return result.ok
      ? { eligible: true, reason: null }
      : { eligible: false, reason: result.reason };
  }

  private async check(
    callerId: string,
    ogcId: OgcId,
    now: Date,
  ): Promise<
    | {
        ok: true;
        calleeId: string;
        numberId: string;
        e164: string;
        /** The caller's own verified phone, rung first (click-to-call). */
        fromE164: string;
        country: string;
        maxPrice: number | null;
      }
    | { ok: false; reason: BridgeIneligibleReason }
  > {
    // Click-to-call rings the caller's own phone first: it must be linked and dialable too.
    const own = await this.numbers.activeNumber(callerId);
    if (!own) return { ok: false, reason: 'CALLER_NUMBER_REQUIRED' };
    if (
      !checkDestination(own.e164, this.settings.countries, this.settings.blockedPrefixes).allowed
    ) {
      return { ok: false, reason: 'COUNTRY_NOT_SUPPORTED' };
    }
    const target = await this.relationships.findActive(ogcId);
    if (!target || target.userId === callerId) return { ok: false, reason: 'UNAVAILABLE' };
    const state = await this.relationships.stateBetween(callerId, target.userId);
    if (state.blockedByViewer || state.blockedByTarget) return { ok: false, reason: 'UNAVAILABLE' };
    if (!state.isContact) return { ok: false, reason: 'NOT_A_CONTACT' };
    const number = await this.numbers.activeNumber(target.userId);
    // Not linked or not opted in: the same answer, so nobody learns whether a number exists.
    if (!number?.allowContactCalls) return { ok: false, reason: 'UNAVAILABLE' };
    const verdict = checkDestination(
      number.e164,
      this.settings.countries,
      this.settings.blockedPrefixes,
    );
    if (!verdict.allowed) {
      return {
        ok: false,
        reason: verdict.reason === 'COUNTRY_NOT_ENABLED' ? 'COUNTRY_NOT_SUPPORTED' : 'UNAVAILABLE',
      };
    }
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const [active, today] = await Promise.all([
      this.prisma.bridgeCall.count({ where: { callerId, status: { in: ACTIVE } } }),
      this.prisma.bridgeCall.count({ where: { callerId, createdAt: { gte: dayStart } } }),
    ]);
    if (active >= this.settings.concurrentCalls || today >= this.settings.callsPerDay) {
      return { ok: false, reason: 'LIMIT_REACHED' };
    }
    let maxPrice: number | null = null;
    if (this.provider.live) {
      // Real calls cost money: a tariff and room under the daily spend cap are required.
      const tariff = await this.billing.tariffFor(number.e164, number.country);
      if (!tariff) return { ok: false, reason: 'COUNTRY_NOT_SUPPORTED' };
      maxPrice = this.billing.maxCallPrice(tariff);
      const spent = await this.billing.spentToday(callerId, now);
      if (spent + maxPrice > this.settings.dailySpendLimitMinor) {
        return { ok: false, reason: 'LIMIT_REACHED' };
      }
    }
    return {
      ok: true,
      calleeId: target.userId,
      numberId: number.id,
      e164: number.e164,
      fromE164: own.e164,
      country: number.country,
      maxPrice,
    };
  }

  /**
   * Starts a call. The same idempotency key always returns the same call (never a second paid
   * call), and a per-caller lock stops concurrent requests from exceeding the limits.
   */
  async start(
    callerId: string,
    ogcId: OgcId,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<BridgeCallView> {
    this.numbers.requireUsable();
    const existing = await this.prisma.bridgeCall.findUnique({
      where: { callerId_idempotencyKey: { callerId, idempotencyKey } },
    });
    if (existing) return this.view(existing);

    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      // Serializes call starts per caller (limits are counted under the lock).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bridge:${callerId}`}))`;
      const again = await tx.bridgeCall.findUnique({
        where: { callerId_idempotencyKey: { callerId, idempotencyKey } },
      });
      if (again) return { call: again, dial: null };
      const result = await this.check(callerId, ogcId, now);
      if (!result.ok) throw notEligible(result.reason);
      const call = await tx.bridgeCall.create({
        data: {
          callerId,
          calleeId: result.calleeId,
          numberId: result.numberId,
          country: result.country,
          provider: this.provider.name,
          simulated: this.provider.simulated,
          idempotencyKey,
          maxDurationSeconds: this.settings.maxCallSeconds,
        },
      });
      await this.audit.record(
        {
          type: 'BRIDGE_CALL_REQUESTED',
          userId: callerId,
          meta,
          details: { callId: call.id, country: call.country, simulated: call.simulated },
        },
        tx,
      );
      return { call, dial: { from: result.fromE164, to: result.e164 } };
    });
    // A retry that found its call already created: nothing new to dial.
    if (!created.dial) return this.view(created.call);

    try {
      const { providerCallId } = await this.provider.startCall(
        {
          callId: created.call.id,
          from: created.dial.from,
          to: created.dial.to,
          maxDurationSeconds: created.call.maxDurationSeconds,
        },
        AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      );
      const updated = await this.prisma.bridgeCall.update({
        where: { id: created.call.id },
        data: { providerCallId },
      });
      return await this.view(updated);
    } catch {
      // The provider did not accept the call: it is over, and it is never charged.
      const failed = await this.finishInternally(created.call.id, 'FAILED', 'PROVIDER_UNAVAILABLE');
      return this.view(failed ?? created.call);
    }
  }

  async get(callerId: string, callId: string): Promise<BridgeCallView> {
    const call = await this.prisma.bridgeCall.findFirst({ where: { id: callId, callerId } });
    if (!call) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Call not found');
    return this.view(call);
  }

  async list(callerId: string): Promise<BridgeCallView[]> {
    const calls = await this.prisma.bridgeCall.findMany({
      where: { callerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return Promise.all(calls.map((c) => this.view(c)));
  }

  /**
   * The caller hangs up. Before the provider has the call, it simply ends; afterwards the
   * provider is asked to end it and its final event decides the outcome (and any charge).
   */
  async cancel(callerId: string, callId: string): Promise<BridgeCallView> {
    const call = await this.prisma.bridgeCall.findFirst({ where: { id: callId, callerId } });
    if (!call) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Call not found');
    if (FINAL.includes(call.status)) return this.view(call);
    if (!call.providerCallId) {
      const ended = await this.finishInternally(call.id, 'CANCELED', 'CANCELED_BY_CALLER');
      return this.view(ended ?? call);
    }
    try {
      await this.provider.endCall(call.providerCallId, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
    } catch {
      throw bridgeNotConfigured();
    }
    const fresh = await this.prisma.bridgeCall.findUniqueOrThrow({ where: { id: call.id } });
    return this.view(fresh);
  }

  /**
   * Applies authenticated provider events. Each event is stored once (replays are ignored),
   * unknown calls are ignored, and state only moves forward: late or out-of-order events never
   * undo a later state, and nothing leaves a final state.
   */
  async applyEvents(provider: string, events: ProviderCallEvent[]): Promise<void> {
    for (const event of events) {
      await this.prisma.$transaction(async (tx) => {
        const call = await tx.bridgeCall.findUnique({
          where: { provider_providerCallId: { provider, providerCallId: event.providerCallId } },
          include: { number: { select: { e164: true } } },
        });
        if (!call) return;
        const stored = await tx.bridgeCallEvent.createMany({
          data: [
            {
              callId: call.id,
              provider,
              providerEventId: event.providerEventId,
              status: event.status,
              occurredAt: event.occurredAt,
              durationSeconds: event.durationSeconds ?? null,
              providerCostMinor: event.costMinor === undefined ? null : BigInt(event.costMinor),
              currency: event.currency ?? null,
            },
          ],
          skipDuplicates: true,
        });
        if (stored.count === 0) return; // Replay of an event already applied.
        if (FINAL.includes(call.status) || RANK[event.status] <= RANK[call.status]) return;
        await this.transition(tx, call, event);
      });
    }
  }

  private async transition(
    tx: Prisma.TransactionClient,
    call: BridgeCall & { number: { e164: string } },
    event: ProviderCallEvent,
  ): Promise<void> {
    const final = FINAL.includes(event.status);
    const duration =
      event.status === 'COMPLETED'
        ? (event.durationSeconds ??
          (call.answeredAt
            ? Math.max(
                0,
                Math.round((event.occurredAt.getTime() - call.answeredAt.getTime()) / 1000),
              )
            : 0))
        : final
          ? 0
          : null;
    // Compare-and-set on the status read in this transaction (concurrent events cannot race).
    const updated = await tx.bridgeCall.updateMany({
      where: { id: call.id, status: call.status },
      data: {
        status: event.status,
        lastEventAt: event.occurredAt,
        ...(event.status === 'ANSWERED' ? { answeredAt: event.occurredAt } : {}),
        ...(final
          ? {
              endedAt: event.occurredAt,
              durationSeconds: duration,
              failureReason: event.status === 'COMPLETED' ? null : (event.reason ?? null),
            }
          : {}),
      },
    });
    if (updated.count !== 1 || !final) return;
    if (event.status === 'COMPLETED' && duration) {
      await this.billing.chargeCompletedCall(tx, call, call.number.e164, duration, event.costMinor);
    }
    await this.audit.record(
      {
        type: 'BRIDGE_CALL_ENDED',
        userId: call.callerId,
        details: {
          callId: call.id,
          status: event.status,
          durationSeconds: duration ?? 0,
          simulated: call.simulated,
        },
      },
      tx,
    );
  }

  /** Ends a call that never reached the provider (or that the provider lost). */
  private async finishInternally(
    callId: string,
    status: BridgeCallStatus,
    reason: string,
  ): Promise<BridgeCall | null> {
    const now = new Date();
    const updated = await this.prisma.bridgeCall.updateMany({
      where: { id: callId, status: { in: ACTIVE } },
      data: { status, endedAt: now, lastEventAt: now, durationSeconds: 0, failureReason: reason },
    });
    const call = await this.prisma.bridgeCall.findUnique({ where: { id: callId } });
    if (updated.count === 1 && call) {
      await this.audit.record({
        type: 'BRIDGE_CALL_ENDED',
        userId: call.callerId,
        details: { callId, status, durationSeconds: 0, simulated: call.simulated },
      });
    }
    return call;
  }

  /**
   * Safety net: ends calls past their maximum length, and asks the provider about calls it has
   * not reported on for a while (a missed webhook, an app closed mid-call).
   */
  async sweep(now: Date): Promise<void> {
    const active = await this.prisma.bridgeCall.findMany({
      where: { status: { in: ACTIVE }, provider: this.provider.name },
      take: 100,
    });
    for (const call of active) {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      if (
        call.status === 'ANSWERED' &&
        call.answeredAt &&
        now.getTime() - call.answeredAt.getTime() > (call.maxDurationSeconds + 30) * 1000 &&
        call.providerCallId
      ) {
        await this.provider.endCall(call.providerCallId, signal).catch(() => undefined);
        continue;
      }
      const last = (call.lastEventAt ?? call.createdAt).getTime();
      if (now.getTime() - last < STALE_MS) continue;
      if (!call.providerCallId) {
        await this.finishInternally(call.id, 'FAILED', 'PROVIDER_UNAVAILABLE');
        continue;
      }
      const snapshot = await this.provider
        .callStatus(call.providerCallId, signal)
        .catch(() => undefined);
      if (snapshot && RANK[snapshot.status] > RANK[call.status]) {
        await this.applyEvents(this.provider.name, [snapshot]);
      } else if (!snapshot) {
        await this.finishInternally(call.id, 'FAILED', 'NO_PROVIDER_UPDATE');
      }
    }
  }

  private async view(call: BridgeCall): Promise<BridgeCallView> {
    const callee = await this.prisma.user.findUniqueOrThrow({
      where: { id: call.calleeId },
      select: { ogcId: true, profile: { select: { displayName: true } } },
    });
    const reason = call.failureReason;
    return {
      id: call.id,
      callee: {
        ogcId: callee.ogcId as OgcId,
        displayName: callee.profile?.displayName ?? callee.ogcId,
      },
      country: call.country,
      status: call.status,
      simulated: call.simulated,
      createdAt: call.createdAt.toISOString(),
      answeredAt: call.answeredAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      durationSeconds: call.durationSeconds,
      failureReason: reason
        ? (REASON_TEXT[reason] ?? reason.replaceAll('_', ' ').toLowerCase())
        : null,
      charge: await this.billing.chargeFor(call.id),
    };
  }
}
