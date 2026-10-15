import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  type ClientEventName,
  type ClientToServerEvents,
  type OgcId,
  type ServerToClientEvents,
  type PresenceView,
  REALTIME_NAMESPACE,
  type RealtimeAck,
} from '@ogc/types';
import {
  callEndSchema,
  callIdSchema,
  callSignalSchema,
  callStartSchema,
  callSyncSchema,
  presenceSubscriptionSchema,
  typingEventSchema,
} from '@ogc/validation';
import type { Socket } from 'socket.io';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { type MessagingLimitName, messagingLimit } from '../../common/throttling/rate-limits.js';
import type { Env } from '../../config/env.schema.js';
import { PrismaService } from '../../database/prisma.service.js';
import { cookieNames } from '../auth/cookies.js';
import { CallError, CallsService } from '../calls/calls.service.js';
import { SessionService } from '../auth/session.service.js';
import {
  ConversationAccessService,
  blockedEitherWay,
} from '../conversations/conversation-access.service.js';
import { allowedRealtimeOrigins } from './io-adapter.js';
import { PRESENCE_HEARTBEAT_MS, PresenceStore } from './presence.store.js';
import {
  type RealtimeNamespace,
  RealtimePublisher,
  type SocketData,
  channelRoom,
  deviceRoom,
  sessionRoom,
  userRoom,
} from './realtime.publisher.js';

type OgcSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const presenceRoom = (userId: string): string => `presence:${userId}`;
const CLIENT_EVENTS: ReadonlySet<string> = new Set<ClientEventName>([
  'typing.start',
  'typing.stop',
  'presence.subscribe',
  'presence.unsubscribe',
  'call.start',
  'call.accept',
  'call.decline',
  'call.cancel',
  'call.end',
  'call.signal',
  'call.connected',
  'call.sync',
]);
/** A socket may watch at most this many accounts' presence. */
const PRESENCE_SUBSCRIPTIONS_MAX = 200;
/** Typing indicators expire on the server if the client never sends `typing.stop`. */
export const TYPING_TIMEOUT_MS = 8_000;
/** Channel rooms joined per socket on connect (most users are in far fewer). */
const CHANNEL_ROOMS_MAX = 1000;
/** How long a socket's "may talk in this conversation" check is cached. */
const ACCESS_CACHE_MS = 15_000;

/**
 * The client's IP address, honouring X-Forwarded-For only for the configured
 * number of trusted proxy hops (the same rule Express applies to REST requests).
 */
export function clientAddress(
  remote: string,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string {
  if (trustedHops === 0 || forwardedFor === undefined) return remote;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // Addresses as seen by each hop: [client, proxy1, …, remote]; skip `trustedHops` from the right.
  const addresses = [...chain, remote];
  return addresses[Math.max(0, addresses.length - 1 - trustedHops)] ?? remote;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * Realtime gateway, protocol v1 (namespace `/v1`, ADR-023). Connections are
 * authenticated with the same session tokens as the REST API — a bearer token
 * in the handshake `auth` (native) or the HttpOnly access cookie plus an
 * allowlisted Origin (web) — and are closed when the access token expires or
 * the session is revoked. Clients may only send the events in the
 * contract (typing, presence and call signaling); each is validated, rate-limited and
 * authorized. Identity always
 * comes from the socket's session, never from the payload.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private namespace: RealtimeNamespace | undefined;
  private readonly local = new Map<string, OgcSocket>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  private readonly accessCache = new Map<string, { recipients: string[]; expires: number }>();
  private readonly presenceSubscriptions = new Map<string, Set<string>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private sessionCheck: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService<Env, true>,
    private readonly publisher: RealtimePublisher,
    private readonly presence: PresenceStore,
    private readonly access: ConversationAccessService,
    private readonly prisma: PrismaService,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
    private readonly calls: CallsService,
    @Inject(ThrottlerStorage) private readonly limiter: ThrottlerStorage,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type === 'session.revoked') this.publisher.disconnectSession(event.sessionId);
      if (event.type === 'user.blocked') {
        // Stop presence sharing in both directions immediately.
        this.namespace?.in(userRoom(event.blockerId)).socketsLeave(presenceRoom(event.blockedId));
        this.namespace?.in(userRoom(event.blockedId)).socketsLeave(presenceRoom(event.blockerId));
        this.accessCache.clear();
      }
      if (event.type === 'membership.changed') {
        this.accessCache.clear();
        if (event.channelId) {
          this.syncChannelRooms(event.channelId, event.userIds).catch((error: unknown) => {
            this.logger.warn({ err: error }, 'Channel room update failed');
          });
        }
      }
    });
    this.heartbeat = setInterval(() => {
      const connections = [...this.local.values()].map((s) => ({
        ...this.identity(s),
        socketId: s.id,
      }));
      this.presence.heartbeat(connections).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Presence heartbeat failed');
      });
    }, PRESENCE_HEARTBEAT_MS);
    this.heartbeat.unref();
    // Defence in depth: sessions revoked or accounts suspended by any path — including an
    // operator changing the database directly — lose their sockets within one interval,
    // not only when the access token expires.
    this.sessionCheck = setInterval(
      () => {
        this.revalidateSessions().catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Realtime session check failed');
        });
      },
      this.config.get('REALTIME_SESSION_CHECK_MS', { infer: true }),
    );
    this.sessionCheck.unref();
  }

  /** Closes local sockets whose session ended or whose account may no longer connect. */
  async revalidateSessions(): Promise<number> {
    const bySession = new Map<string, OgcSocket[]>();
    for (const socket of this.local.values()) {
      const { sessionId } = this.identity(socket);
      bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), socket]);
    }
    const ids = [...bySession.keys()];
    let closed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await this.prisma.session.findMany({
        where: { id: { in: chunk } },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          expiresAt: true,
          user: { select: { status: true } },
        },
      });
      const found = new Map(rows.map((row) => [row.id, row]));
      const now = Date.now();
      for (const sessionId of chunk) {
        const row = found.get(sessionId);
        if (row === undefined) {
          for (const socket of bySession.get(sessionId) ?? []) socket.disconnect(true);
          continue;
        }
        const ended = row.revokedAt !== null || row.expiresAt.getTime() <= now;
        if (!ended && row.user.status === 'ACTIVE') continue;
        if (!ended && row.user.status !== 'PENDING_VERIFICATION') {
          // Suspended or deactivated: end the session everywhere (publishes session.revoked).
          await this.sessions.revoke(row.id, row.userId, 'ACCOUNT_DISABLED', {});
        }
        for (const socket of bySession.get(sessionId) ?? []) {
          socket.disconnect(true);
          closed += 1;
        }
      }
    }
    return closed;
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.sessionCheck) clearInterval(this.sessionCheck);
    for (const timer of [...this.expiryTimers.values(), ...this.typingTimers.values()])
      clearTimeout(timer);
  }

  afterInit(namespace: RealtimeNamespace): void {
    this.namespace = namespace;
    this.publisher.attach(namespace);
    namespace.use((socket, next) => {
      this.authenticate(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          this.logger.debug(
            { reason: error instanceof Error ? error.message : 'unknown' },
            'Realtime connection rejected',
          );
          next(new Error('unauthorized'));
        },
      );
    });
  }

  private identity(socket: OgcSocket): SocketData {
    return socket.data;
  }

  private async consume(name: MessagingLimitName, key: string): Promise<boolean> {
    const { limit, ttl } = messagingLimit(name);
    const record = await this.limiter.increment(`ws:${name}:${key}`, ttl, limit, ttl, 'realtime');
    if (record.isBlocked) this.metrics.rateLimited.inc({ scope: `realtime_${name}` });
    return !record.isBlocked;
  }

  private async authenticate(socket: OgcSocket): Promise<void> {
    const ip = clientAddress(
      socket.handshake.address,
      socket.handshake.headers['x-forwarded-for'],
      this.config.get('TRUST_PROXY_HOPS', { infer: true }),
    );
    if (!(await this.consume('socketConnect', `ip:${ip}`))) throw new Error('rate limited');

    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const bearer =
      typeof auth?.token === 'string' && auth.token.length > 0 ? auth.token : undefined;
    let token = bearer;
    if (!token) {
      // Cookie authentication is for browsers only: require an allowlisted Origin.
      const origin = socket.handshake.headers.origin;
      if (!origin || !allowedRealtimeOrigins(this.config).has(origin)) throw new Error('origin');
      token = readCookie(
        socket.handshake.headers.cookie,
        cookieNames(this.config.get('COOKIE_SECURE', { infer: true })).access,
      );
    }
    if (!token) throw new Error('no token');
    const context = await this.sessions.authenticate(token, bearer ? 'bearer' : 'cookie');
    if (context.accountStatus !== 'ACTIVE') throw new Error('inactive');
    if (!(await this.consume('socketConnect', `user:${context.userId}`)))
      throw new Error('rate limited');
    socket.data = {
      userId: context.userId,
      ogcId: context.ogcId,
      sessionId: context.sessionId,
      deviceId: context.deviceId,
    };
    // Close the connection when the access token expires; the client refreshes and reconnects.
    const remaining = Math.max(
      0,
      Math.min(context.accessExpiresAt.getTime() - Date.now(), 2 ** 31 - 1),
    );
    this.expiryTimers.set(
      socket.id,
      setTimeout(() => socket.disconnect(true), remaining),
    );
  }

  async handleConnection(socket: OgcSocket): Promise<void> {
    const { userId, deviceId, sessionId } = this.identity(socket);
    this.local.set(socket.id, socket);
    this.metrics.socketConnections.inc();
    // The client contract is closed: any other event name is a protocol violation.
    socket.onAny((event: unknown) => {
      if (typeof event !== 'string' || !CLIENT_EVENTS.has(event)) {
        this.metrics.failures.inc({ operation: 'realtime', reason: 'unknown_event' });
        socket.disconnect(true);
      }
    });
    await socket.join([userRoom(userId), deviceRoom(deviceId), sessionRoom(sessionId)]);
    // Community channel events go to channel rooms (active members only).
    const channels = await this.prisma.channelMember.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { channelId: true },
      take: CHANNEL_ROOMS_MAX,
    });
    if (channels.length > 0) await socket.join(channels.map((c) => channelRoom(c.channelId)));
    const cameOnline = await this.presence
      .connect({ userId, deviceId, socketId: socket.id })
      .catch((error: unknown) => this.presenceFailed(error, false));
    if (cameOnline) this.emitPresence(userId, 'ONLINE');
  }

  async handleDisconnect(socket: OgcSocket): Promise<void> {
    if (!this.local.delete(socket.id)) return;
    this.metrics.socketConnections.dec();
    const timer = this.expiryTimers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(socket.id);
    this.presenceSubscriptions.delete(socket.id);
    const { userId, deviceId, ogcId } = this.identity(socket);
    for (const [key, typing] of this.typingTimers) {
      if (!key.startsWith(`${socket.id}:`)) continue;
      clearTimeout(typing);
      this.typingTimers.delete(key);
      const conversationId = key.slice(socket.id.length + 1);
      const cached = this.accessCache.get(`${socket.id}:${conversationId}`);
      if (cached)
        this.publisher.toUsers(cached.recipients, 'message.typing', {
          conversationId,
          ogcId: ogcId as OgcId,
          typing: false,
        });
    }
    for (const key of this.accessCache.keys())
      if (key.startsWith(`${socket.id}:`)) this.accessCache.delete(key);
    const wentOffline = await this.presence
      .disconnect({ userId, deviceId, socketId: socket.id })
      .catch((error: unknown) => this.presenceFailed(error, false));
    if (wentOffline) this.emitPresence(userId, 'OFFLINE');
  }

  /** Moves users' sockets into or out of a channel room to match their membership. */
  private async syncChannelRooms(channelId: string, userIds: string[]): Promise<void> {
    const active = await this.prisma.channelMember.findMany({
      where: { channelId, userId: { in: userIds }, status: 'ACTIVE' },
      select: { userId: true },
    });
    const members = new Set(active.map((a) => a.userId));
    for (const userId of userIds) {
      this.publisher.setChannelMembership(userId, channelId, members.has(userId));
      if (!members.has(userId)) {
        this.publisher.toUsers([userId], 'channel.access_revoked', { channelId });
      }
    }
  }

  /** Presence is best-effort: a Redis outage must never break connections. */
  private presenceFailed(error: unknown, fallback: boolean): boolean {
    this.logger.warn(
      { message: error instanceof Error ? error.message : 'unknown' },
      'Presence update failed',
    );
    return fallback;
  }

  private emitPresence(userId: string, state: PresenceView['state']): void {
    const socket = [...this.local.values()].find((s) => this.identity(s).userId === userId);
    const ogcId = socket ? this.identity(socket).ogcId : undefined;
    const send = (id: string): void => {
      this.namespace
        ?.to(presenceRoom(userId))
        .emit('presence.updated', { ogcId: id as OgcId, state });
    };
    if (ogcId) {
      send(ogcId);
      return;
    }
    void this.prisma.user
      .findUnique({ where: { id: userId }, select: { ogcId: true } })
      .then((user) => {
        if (user) send(user.ogcId);
      });
  }

  /**
   * Who sees the caller typing: the other participants with no block in either
   * direction (none in an archived group). Cached briefly.
   */
  private async typingRecipients(socket: OgcSocket, conversationId: string): Promise<string[]> {
    const key = `${socket.id}:${conversationId}`;
    const cached = this.accessCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.recipients;
    try {
      const userId = this.identity(socket).userId;
      const access = await this.access.require(userId, conversationId);
      const recipients = access.group?.archived
        ? []
        : access.otherIds.filter((id) => !blockedEitherWay(access, userId, id));
      this.accessCache.set(key, { recipients, expires: Date.now() + ACCESS_CACHE_MS });
      return recipients;
    } catch {
      return [];
    }
  }

  @SubscribeMessage('typing.start')
  async typingStart(
    @ConnectedSocket() socket: OgcSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.typing(socket, body, true);
  }

  @SubscribeMessage('typing.stop')
  async typingStop(
    @ConnectedSocket() socket: OgcSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    await this.typing(socket, body, false);
  }

  private async typing(socket: OgcSocket, body: unknown, typing: boolean): Promise<void> {
    const parsed = typingEventSchema.safeParse(body);
    if (!parsed.success) return;
    const { userId, ogcId } = this.identity(socket);
    if (typing && !(await this.consume('typing', `user:${userId}`))) return;
    const { conversationId } = parsed.data;
    const recipients = await this.typingRecipients(socket, conversationId);
    if (recipients.length === 0) return;
    const key = `${socket.id}:${conversationId}`;
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    this.typingTimers.delete(key);
    if (typing) {
      this.typingTimers.set(
        key,
        setTimeout(() => {
          this.typingTimers.delete(key);
          this.publisher.toUsers(recipients, 'message.typing', {
            conversationId,
            ogcId: ogcId as OgcId,
            typing: false,
          });
        }, TYPING_TIMEOUT_MS),
      );
    } else if (!existing) {
      return;
    }
    this.publisher.toUsers(recipients, 'message.typing', {
      conversationId,
      ogcId: ogcId as OgcId,
      typing,
    });
  }

  /**
   * Starts watching the presence of accounts the caller shares a DIRECT
   * conversation with (and no block either way). Group membership alone does
   * not share presence. Other IDs are silently ignored, so this
   * cannot be used to learn whether arbitrary accounts are online.
   */
  @SubscribeMessage('presence.subscribe')
  async presenceSubscribe(
    @ConnectedSocket() socket: OgcSocket,
    @MessageBody() body: unknown,
  ): Promise<Parameters<RealtimeAck<PresenceView[]>>[0]> {
    const parsed = presenceSubscriptionSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    const { userId } = this.identity(socket);
    if (!(await this.consume('presence', `user:${userId}`)))
      return { ok: false, error: 'rate_limited' };

    const peers = await this.prisma.user.findMany({
      where: {
        ogcId: { in: parsed.data.ogcIds },
        status: 'ACTIVE',
        participations: {
          some: { conversation: { type: 'DIRECT', participants: { some: { userId } } } },
        },
        blocksMade: { none: { blockedId: userId } },
        blocksReceived: { none: { blockerId: userId } },
      },
      select: { id: true, ogcId: true },
    });
    const subscriptions = this.presenceSubscriptions.get(socket.id) ?? new Set<string>();
    const allowed = peers
      .filter((p) => p.id !== userId)
      .filter((p) => {
        if (subscriptions.has(p.id)) return true;
        if (subscriptions.size >= PRESENCE_SUBSCRIPTIONS_MAX) return false;
        subscriptions.add(p.id);
        return true;
      });
    this.presenceSubscriptions.set(socket.id, subscriptions);
    await socket.join(allowed.map((p) => presenceRoom(p.id)));
    const online = await this.presence.onlineUsers(allowed.map((p) => p.id));
    return {
      ok: true,
      data: allowed.map((p) => ({
        ogcId: p.ogcId as OgcId,
        state: online.has(p.id) ? 'ONLINE' : 'OFFLINE',
      })),
    };
  }

  @SubscribeMessage('presence.unsubscribe')
  async presenceUnsubscribe(
    @ConnectedSocket() socket: OgcSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const parsed = presenceSubscriptionSchema.safeParse(body);
    if (!parsed.success) return;
    const users = await this.prisma.user.findMany({
      where: { ogcId: { in: parsed.data.ogcIds } },
      select: { id: true },
    });
    const subscriptions = this.presenceSubscriptions.get(socket.id);
    for (const user of users) {
      subscriptions?.delete(user.id);
      await socket.leave(presenceRoom(user.id));
    }
  }

  // ── One-to-one calls (ADR-037) ──────────────────────────────────────────────────────────
  // Identity (user and device) comes from the socket session. Payloads are never logged:
  // session descriptions and ICE candidates contain network addresses.

  /**
   * Validates, rate-limits and runs a call operation, turning refusals into an
   * acknowledgement error code. Unexpected failures are logged without the payload.
   */
  private async callOperation<T>(
    socket: OgcSocket,
    limit: 'callStart' | 'callSignal',
    run: (actor: { userId: string; deviceId: string }) => Promise<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const { userId, deviceId } = this.identity(socket);
    if (!(await this.consume(limit, `user:${userId}`))) return { ok: false, error: 'rate_limited' };
    try {
      return { ok: true, data: await run({ userId, deviceId }) };
    } catch (error) {
      if (error instanceof CallError) {
        this.metrics.failures.inc({ operation: 'call', reason: error.code });
        return { ok: false, error: error.code };
      }
      this.metrics.failures.inc({ operation: 'call', reason: 'error' });
      this.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'Call operation failed',
      );
      return { ok: false, error: 'unavailable' };
    }
  }

  @SubscribeMessage('call.start')
  async callStart(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callStartSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callStart', (actor) =>
      this.calls.start(actor, parsed.data.conversationId, parsed.data.media),
    );
  }

  @SubscribeMessage('call.accept')
  async callAccept(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callIdSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', (actor) =>
      this.calls.accept(actor, parsed.data.callId, socket.id),
    );
  }

  @SubscribeMessage('call.decline')
  async callDecline(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callIdSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', async (actor) => {
      await this.calls.decline(actor, parsed.data.callId);
      return null;
    });
  }

  @SubscribeMessage('call.cancel')
  async callCancel(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callIdSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', async (actor) => {
      await this.calls.end(actor, parsed.data.callId);
      return null;
    });
  }

  @SubscribeMessage('call.end')
  async callEnd(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callEndSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', async (actor) => {
      await this.calls.end(actor, parsed.data.callId, parsed.data.reason === 'failed');
      return null;
    });
  }

  @SubscribeMessage('call.signal')
  async callSignal(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callSignalSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', async (actor) => {
      await this.calls.signal(actor, parsed.data.callId, parsed.data.signal);
      return null;
    });
  }

  @SubscribeMessage('call.connected')
  async callConnected(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callIdSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', async (actor) => {
      await this.calls.connected(actor, parsed.data.callId);
      return null;
    });
  }

  @SubscribeMessage('call.sync')
  async callSync(@ConnectedSocket() socket: OgcSocket, @MessageBody() body: unknown) {
    const parsed = callSyncSchema.safeParse(body ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid' };
    return this.callOperation(socket, 'callSignal', (actor) => this.calls.current(actor));
  }
}
