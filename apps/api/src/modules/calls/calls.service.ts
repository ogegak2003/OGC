import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CallEndReason,
  CallErrorCode,
  CallMedia,
  CallPage,
  CallSetup,
  CallSignal,
  CallView,
  ProfileSummary,
} from '@ogc/types';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RelationshipService } from '../relationships/relationship.service.js';
import {
  type Actor,
  type CallSnapshot,
  type Ending,
  authorize,
  blockedDuringCall,
  deviceLost,
  durationSeconds,
  hangUp,
  requiredDevices,
  timedOut,
} from './call-rules.js';
import { type IceConfig, iceServersFor } from './ice-servers.js';

/** A refused call operation; the gateway returns `code` in the acknowledgement. */
export class CallError extends Error {
  constructor(readonly code: CallErrorCode) {
    super(code);
    this.name = 'CallError';
  }
}

const OPEN = ['RINGING', 'ACCEPTED'] as const;
const HOUR_MS = 60 * 60 * 1000;
/** Open calls examined per sweep (far more than a single instance should ever have). */
const SWEEP_BATCH = 1000;

const callSelect = {
  id: true,
  conversationId: true,
  callerId: true,
  calleeId: true,
  callerDeviceId: true,
  calleeDeviceId: true,
  media: true,
  status: true,
  outcome: true,
  hiddenFromCallee: true,
  createdAt: true,
  answeredAt: true,
  connectedAt: true,
  endedAt: true,
} as const satisfies Prisma.CallSelect;

type CallRow = Prisma.CallGetPayload<{ select: typeof callSelect }>;

const accountSelect = {
  id: true,
  ogcId: true,
  profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
} as const satisfies Prisma.UserSelect;

/** Calls that `userId` takes part in and can see (a hidden call is the caller's alone). */
const visibleTo = (userId: string): Prisma.CallWhereInput => ({
  OR: [{ callerId: userId }, { calleeId: userId, hiddenFromCallee: false }],
});

/**
 * One-to-one call signaling and history (ADR-037). Every operation is authorized against
 * the stored call and the sender's session (user and device); transitions are conditional
 * updates on the expected state, so they are safe across API instances and concurrent
 * events. Session descriptions and ICE candidates are relayed, never stored or logged.
 */
@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name);
  private sweeper: NodeJS.Timeout | undefined;
  private sweeping = false;
  private lastRetention = 0;
  private unsubscribe: (() => void) | undefined;
  /** `<callId>:<deviceId>` → when this instance first saw that device offline. */
  private readonly offlineSince = new Map<string, number>();
  private readonly ice: IceConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly relationships: RelationshipService,
    private readonly publisher: RealtimePublisher,
    private readonly presence: PresenceStore,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.ice = {
      stunUrls: config.get('WEBRTC_STUN_URLS', { infer: true }),
      turnUrls: config.get('WEBRTC_TURN_URLS', { infer: true }),
      turnSecret: config.get('WEBRTC_TURN_SECRET', { infer: true }),
      turnTtlSeconds: config.get('WEBRTC_TURN_CREDENTIAL_TTL_SECONDS', { infer: true }),
    };
  }

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type !== 'user.blocked') return;
      this.endForBlock(event.blockerId, event.blockedId).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Ending calls after a block failed');
      });
    });
    this.sweeper = setInterval(
      () => {
        void this.sweep();
      },
      this.config.get('CALL_SWEEP_INTERVAL_MS', { infer: true }),
    );
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.sweeper) clearInterval(this.sweeper);
  }

  // ── Commands (from the realtime gateway; `actor` comes from the socket session) ──────────

  async start(actor: Actor, conversationId: string, media: CallMedia): Promise<CallSetup> {
    const access = await this.access.require(actor.userId, conversationId).catch(() => {
      throw new CallError('not_found');
    });
    if (access.type !== 'DIRECT' || !access.peerId) throw new CallError('unavailable');
    // Same rules as sending a message: refused if you blocked them or their account is not
    // active. If *they* blocked *you*, the call "rings" for you but never reaches them.
    if (access.blockedByViewer || access.peerStatus !== 'ACTIVE') {
      throw new CallError('unavailable');
    }
    const peerId = access.peerId;
    const hidden = access.blockedByPeer;

    const call = await this.prisma.$transaction(async (tx) => {
      // Serialise call creation per account (both participants, in a fixed order), so two
      // simultaneous calls can never both find the other person free.
      for (const userId of [actor.userId, peerId].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`call:${userId}`}, 0))`;
      }
      const mine = await tx.call.count({
        where: { status: { in: [...OPEN] }, ...visibleTo(actor.userId) },
      });
      if (mine > 0) throw new CallError('in_call');
      const busy =
        !hidden &&
        (await tx.call.count({ where: { status: { in: [...OPEN] }, ...visibleTo(peerId) } })) > 0;
      return tx.call.create({
        data: {
          conversationId,
          callerId: actor.userId,
          calleeId: peerId,
          callerDeviceId: actor.deviceId,
          media,
          hiddenFromCallee: hidden,
          ...(busy ? { status: 'ENDED', outcome: 'BUSY', endedAt: new Date() } : {}),
        },
        select: callSelect,
      });
    });

    this.metrics.callsStarted.inc({ media });
    if (call.status === 'ENDED') {
      this.metrics.callsEnded.inc({ media, outcome: 'BUSY' });
    } else if (!hidden) {
      const [view] = await this.viewsFor(call, [call.calleeId]);
      if (view) this.publisher.toUsers([call.calleeId], 'call.incoming', { call: view });
      this.events.publish({
        type: 'call.ringing',
        callId: call.id,
        conversationId,
        calleeId: call.calleeId,
      });
    }
    return this.setup(call, actor.userId);
  }

  async accept(actor: Actor, callId: string, socketId: string): Promise<CallSetup> {
    const call = await this.load(callId);
    this.check(call, actor, 'accept');
    const answeredAt = new Date();
    const { count } = await this.prisma.call.updateMany({
      where: { id: callId, status: 'RINGING', calleeId: actor.userId, hiddenFromCallee: false },
      data: { status: 'ACCEPTED', answeredAt, calleeDeviceId: actor.deviceId },
    });
    if (count === 0) {
      // Lost a race: another device answered, or the call ended meanwhile.
      this.check(await this.load(callId), actor, 'accept');
      throw new CallError('ended');
    }
    const accepted: CallRow = {
      ...call,
      status: 'ACCEPTED',
      answeredAt,
      calleeDeviceId: actor.deviceId,
    };
    if (call.callerDeviceId) {
      this.publisher.toDevices([call.callerDeviceId], 'call.accepted', { callId });
    }
    // Every other tab and device of the callee stops ringing.
    this.publisher.toUsersExceptSocket([actor.userId], socketId, 'call.answered_elsewhere', {
      callId,
    });
    return this.setup(accepted, actor.userId);
  }

  async decline(actor: Actor, callId: string): Promise<void> {
    this.check(await this.load(callId), actor, 'decline');
    const ended = await this.finish(callId, (call) =>
      authorize(call, actor, 'decline') ? undefined : { outcome: 'DECLINED', reason: 'declined' },
    );
    if (!ended) this.check(await this.load(callId), actor, 'decline');
  }

  /** Cancel (ringing, caller) and hang up (in a call) share one rule: see `hangUp`. */
  async end(actor: Actor, callId: string, failed = false): Promise<void> {
    this.check(await this.load(callId), actor, 'end');
    const ended = await this.finish(callId, (call) =>
      authorize(call, actor, 'end') ? undefined : hangUp(call, actor, failed),
    );
    if (!ended) this.check(await this.load(callId), actor, 'end');
  }

  /** Relays an offer, answer, ICE candidate or media-state update to the other device. */
  async signal(actor: Actor, callId: string, signal: CallSignal): Promise<void> {
    const call = await this.load(callId);
    this.check(call, actor, 'signal', signal.type);
    const fromCaller = actor.userId === call.callerId;
    const target = fromCaller ? call.calleeDeviceId : call.callerDeviceId;
    if (!target) throw new CallError('ended');
    this.publisher.toDevices([target], 'call.signal', { callId, signal });
  }

  /** Media is flowing: the first report starts the duration. Later reports are no-ops. */
  async connected(actor: Actor, callId: string): Promise<void> {
    this.check(await this.load(callId), actor, 'connected');
    await this.prisma.call.updateMany({
      where: { id: callId, status: 'ACCEPTED', connectedAt: null },
      data: { connectedAt: new Date() },
    });
  }

  /** The account's open call (newest), to restore the call screen after a reconnect. */
  async current(actor: Actor): Promise<{ call: CallView; onThisDevice: boolean } | null> {
    const call = await this.prisma.call.findFirst({
      where: { status: { in: [...OPEN] }, ...visibleTo(actor.userId) },
      orderBy: { createdAt: 'desc' },
      select: callSelect,
    });
    if (!call) return null;
    const [view] = await this.viewsFor(call, [actor.userId]);
    if (!view) return null;
    const onThisDevice =
      (actor.userId === call.callerId && actor.deviceId === call.callerDeviceId) ||
      (actor.userId === call.calleeId && actor.deviceId === call.calleeDeviceId);
    return { call: view, onThisDevice };
  }

  // ── History (REST) ────────────────────────────────────────────────────────────────────────

  async history(
    viewerId: string,
    query: { conversationId?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<CallPage> {
    // Conversation history requires current participation (404 otherwise, as for messages).
    if (query.conversationId) await this.access.require(viewerId, query.conversationId);
    const before = decodeCursor(query.cursor);
    const rows = await this.prisma.call.findMany({
      where: {
        ...visibleTo(viewerId),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: callSelect,
    });
    const peerIds = [
      ...new Set(rows.map((r) => (r.callerId === viewerId ? r.calleeId : r.callerId))),
    ];
    const peers = await this.prisma.user.findMany({
      where: { id: { in: peerIds } },
      select: accountSelect,
    });
    const summaries = await this.relationships.summariesFor(viewerId, peers);
    return toPage(rows, query.limit, (row) =>
      this.toView(
        row,
        viewerId,
        summaries.get(row.callerId === viewerId ? row.calleeId : row.callerId),
      ),
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private async load(callId: string): Promise<CallRow> {
    const call = await this.prisma.call.findUnique({ where: { id: callId }, select: callSelect });
    if (!call) throw new CallError('not_found');
    return call;
  }

  private check(
    call: CallSnapshot,
    actor: Actor,
    command: Parameters<typeof authorize>[2],
    signal?: CallSignal['type'],
  ): void {
    const denied = authorize(call, actor, command, signal);
    if (denied) throw new CallError(denied);
  }

  /**
   * Ends an open call if `decide` says so, with a conditional update on the state it decided
   * from (retried if the call changed underneath, e.g. media connected meanwhile). Announces
   * the result once, from whichever instance's update won.
   */
  private async finish(
    callId: string,
    decide: (call: CallRow) => Ending | undefined,
  ): Promise<CallRow | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const call = await this.prisma.call.findUnique({
        where: { id: callId },
        select: callSelect,
      });
      if (!call || call.status === 'ENDED') return undefined;
      const ending = decide(call);
      if (!ending) return undefined;
      const endedAt = new Date();
      const { count } = await this.prisma.call.updateMany({
        where: {
          id: callId,
          status: call.status,
          connectedAt: call.connectedAt ? { not: null } : null,
        },
        data: { status: 'ENDED', outcome: ending.outcome, endedAt },
      });
      if (count === 1) {
        const ended: CallRow = {
          ...call,
          status: 'ENDED',
          outcome: ending.outcome,
          endedAt,
        };
        await this.announceEnded(ended, ending.reason);
        return ended;
      }
    }
    return undefined;
  }

  private async announceEnded(call: CallRow, reason: CallEndReason): Promise<void> {
    this.metrics.callsEnded.inc({ media: call.media, outcome: call.outcome ?? 'FAILED' });
    const viewers = call.hiddenFromCallee ? [call.callerId] : [call.callerId, call.calleeId];
    const views = await this.viewsFor(call, viewers);
    for (const view of views) {
      const viewer = view.direction === 'OUTGOING' ? call.callerId : call.calleeId;
      this.publisher.toUsers([viewer], 'call.ended', { call: view, reason });
    }
    if (call.outcome === 'MISSED' && !call.hiddenFromCallee) {
      this.events.publish({
        type: 'call.missed',
        callId: call.id,
        conversationId: call.conversationId,
        calleeId: call.calleeId,
      });
    }
  }

  private async setup(call: CallRow, viewerId: string): Promise<CallSetup> {
    const [view] = await this.viewsFor(call, [viewerId]);
    if (!view) throw new CallError('not_found');
    return {
      call: view,
      iceServers: iceServersFor(this.ice, call.id),
      iceTransportPolicy: this.config.get('WEBRTC_ICE_TRANSPORT_POLICY', { infer: true }),
    };
  }

  /** The call as each viewer sees it (the peer's photo only where that viewer may see it). */
  private async viewsFor(call: CallRow, viewerIds: string[]): Promise<CallView[]> {
    const accounts = await this.prisma.user.findMany({
      where: { id: { in: [call.callerId, call.calleeId] } },
      select: accountSelect,
    });
    const views: CallView[] = [];
    for (const viewerId of viewerIds) {
      const summaries = await this.relationships.summariesFor(viewerId, accounts);
      const peerId = viewerId === call.callerId ? call.calleeId : call.callerId;
      views.push(this.toView(call, viewerId, summaries.get(peerId)));
    }
    return views;
  }

  private toView(call: CallRow, viewerId: string, peer: ProfileSummary | undefined): CallView {
    return {
      id: call.id,
      conversationId: call.conversationId,
      media: call.media,
      direction: call.callerId === viewerId ? 'OUTGOING' : 'INCOMING',
      peer: peer ?? { ogcId: '' as ProfileSummary['ogcId'], displayName: '', avatarUrl: null },
      status: call.status,
      outcome: call.outcome,
      createdAt: call.createdAt.toISOString(),
      answeredAt: call.answeredAt?.toISOString() ?? null,
      connectedAt: call.connectedAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      durationSeconds: durationSeconds(call.connectedAt, call.endedAt),
    };
  }

  private async endForBlock(blockerId: string, blockedId: string): Promise<void> {
    const calls = await this.prisma.call.findMany({
      where: {
        status: { in: [...OPEN] },
        OR: [
          { callerId: blockerId, calleeId: blockedId },
          { callerId: blockedId, calleeId: blockerId },
        ],
      },
      select: { id: true },
    });
    for (const { id } of calls) {
      await this.finish(id, (call) => blockedDuringCall(call, blockerId));
    }
  }

  /** Whether a required device has been offline longer than the reconnection grace period. */
  private offlineTooLong(callId: string, deviceId: string, online: boolean, now: number): boolean {
    const key = `${callId}:${deviceId}`;
    if (online) {
      this.offlineSince.delete(key);
      return false;
    }
    const since = this.offlineSince.get(key) ?? now;
    this.offlineSince.set(key, since);
    return now - since >= this.config.get('CALL_RECONNECT_GRACE_SECONDS', { infer: true }) * 1000;
  }

  /**
   * Runs on every instance: ends unanswered, never-connected, abandoned and too-long calls,
   * and calls whose device lost its realtime connection for longer than the grace period.
   * Conditional updates make concurrent sweeps on several instances harmless.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const open = await this.prisma.call.findMany({
        where: { status: { in: [...OPEN] } },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
        select: callSelect,
      });
      this.metrics.openCalls.set(open.length);
      const devices = [...new Set(open.flatMap((call) => requiredDevices(call)))];
      const online = devices.length > 0 ? await this.presence.onlineDevices(devices) : new Set();
      const timing = (call: CallRow) => ({
        now,
        createdAt: call.createdAt.getTime(),
        answeredAt: call.answeredAt?.getTime() ?? null,
        ringTimeoutMs: this.config.get('CALL_RING_TIMEOUT_SECONDS', { infer: true }) * 1000,
        connectTimeoutMs: this.config.get('CALL_CONNECT_TIMEOUT_SECONDS', { infer: true }) * 1000,
        maxDurationMs: this.config.get('CALL_MAX_DURATION_MINUTES', { infer: true }) * 60_000,
      });
      const openIds = new Set(open.map((call) => call.id));
      for (const call of open) {
        const lost = requiredDevices(call).filter((device) =>
          this.offlineTooLong(call.id, device, online.has(device), now),
        );
        if (!timedOut(call, timing(call)) && lost.length === 0) continue;
        await this.finish(call.id, (latest) => {
          const timeout = timedOut(latest, timing(latest));
          if (timeout) return timeout;
          // Still waiting on the same lost device(s) in the same state.
          const required = requiredDevices(latest);
          return latest.status === call.status && lost.some((d) => required.includes(d))
            ? deviceLost(latest)
            : undefined;
        });
      }
      for (const key of this.offlineSince.keys()) {
        if (!openIds.has(key.slice(0, key.indexOf(':')))) this.offlineSince.delete(key);
      }
      if (now - this.lastRetention >= HOUR_MS) {
        this.lastRetention = now;
        const days = this.config.get('CALL_HISTORY_RETENTION_DAYS', { infer: true });
        await this.prisma.call.deleteMany({
          where: { status: 'ENDED', createdAt: { lt: new Date(now - days * 24 * HOUR_MS) } },
        });
      }
    } catch (error) {
      this.logger.warn(
        { message: error instanceof Error ? error.message : 'unknown' },
        'Call sweep failed',
      );
    } finally {
      this.sweeping = false;
    }
  }
}
