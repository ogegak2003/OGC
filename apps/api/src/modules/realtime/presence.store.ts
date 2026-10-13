import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisConnections } from '../../common/redis/redis.module.js';

/** A connection is considered alive for this long after its last heartbeat. */
export const PRESENCE_TTL_MS = 90_000;
export const PRESENCE_HEARTBEAT_MS = 30_000;

export interface PresenceConnection {
  userId: string;
  deviceId: string;
  socketId: string;
}

/**
 * Approximate presence (ADR-026): which accounts and devices have at least one
 * live realtime connection. Never written to PostgreSQL. Entries expire
 * unless refreshed, so a crashed instance cannot leave users "online" forever.
 */
export interface PresenceBackend {
  /** Returns true if this made the user go from offline to online. */
  connect(connection: PresenceConnection): Promise<boolean>;
  /** Returns true if this made the user go offline. */
  disconnect(connection: PresenceConnection): Promise<boolean>;
  heartbeat(connections: PresenceConnection[]): Promise<void>;
  onlineUsers(userIds: string[]): Promise<Set<string>>;
  onlineDevices(deviceIds: string[]): Promise<Set<string>>;
}

class MemoryPresence implements PresenceBackend {
  private readonly users = new Map<string, Map<string, number>>();
  private readonly devices = new Map<string, Map<string, number>>();

  private static live(map: Map<string, Map<string, number>>, key: string, now: number): number {
    const sockets = map.get(key);
    if (!sockets) return 0;
    for (const [socket, expires] of sockets) if (expires <= now) sockets.delete(socket);
    if (sockets.size === 0) map.delete(key);
    return sockets.size;
  }

  private static add(
    map: Map<string, Map<string, number>>,
    key: string,
    socketId: string,
    expires: number,
  ): void {
    const sockets = map.get(key) ?? new Map<string, number>();
    sockets.set(socketId, expires);
    map.set(key, sockets);
  }

  connect(c: PresenceConnection): Promise<boolean> {
    const now = Date.now();
    const before = MemoryPresence.live(this.users, c.userId, now);
    MemoryPresence.add(this.users, c.userId, c.socketId, now + PRESENCE_TTL_MS);
    MemoryPresence.add(this.devices, c.deviceId, c.socketId, now + PRESENCE_TTL_MS);
    return Promise.resolve(before === 0);
  }

  disconnect(c: PresenceConnection): Promise<boolean> {
    const now = Date.now();
    this.users.get(c.userId)?.delete(c.socketId);
    this.devices.get(c.deviceId)?.delete(c.socketId);
    MemoryPresence.live(this.devices, c.deviceId, now);
    return Promise.resolve(MemoryPresence.live(this.users, c.userId, now) === 0);
  }

  heartbeat(connections: PresenceConnection[]): Promise<void> {
    const expires = Date.now() + PRESENCE_TTL_MS;
    for (const c of connections) {
      MemoryPresence.add(this.users, c.userId, c.socketId, expires);
      MemoryPresence.add(this.devices, c.deviceId, c.socketId, expires);
    }
    return Promise.resolve();
  }

  onlineUsers(userIds: string[]): Promise<Set<string>> {
    const now = Date.now();
    return Promise.resolve(
      new Set(userIds.filter((id) => MemoryPresence.live(this.users, id, now) > 0)),
    );
  }

  onlineDevices(deviceIds: string[]): Promise<Set<string>> {
    const now = Date.now();
    return Promise.resolve(
      new Set(deviceIds.filter((id) => MemoryPresence.live(this.devices, id, now) > 0)),
    );
  }
}

/** Sorted sets of socket IDs scored by expiry time, updated atomically with Lua. */
const CONNECT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local before = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return before
`;
const DISCONNECT = `
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])
`;

class RedisPresence implements PresenceBackend {
  constructor(private readonly redis: Redis) {}

  private static userKey = (id: string): string => `ogc:presence:u:${id}`;
  private static deviceKey = (id: string): string => `ogc:presence:d:${id}`;

  async connect(c: PresenceConnection): Promise<boolean> {
    const now = Date.now();
    const before = (await this.redis.eval(
      CONNECT,
      2,
      RedisPresence.userKey(c.userId),
      RedisPresence.deviceKey(c.deviceId),
      String(now),
      String(now + PRESENCE_TTL_MS),
      c.socketId,
      String(PRESENCE_TTL_MS),
    )) as number;
    return before === 0;
  }

  async disconnect(c: PresenceConnection): Promise<boolean> {
    const remaining = (await this.redis.eval(
      DISCONNECT,
      2,
      RedisPresence.userKey(c.userId),
      RedisPresence.deviceKey(c.deviceId),
      String(Date.now()),
      c.socketId,
    )) as number;
    return remaining === 0;
  }

  async heartbeat(connections: PresenceConnection[]): Promise<void> {
    if (connections.length === 0) return;
    const expires = Date.now() + PRESENCE_TTL_MS;
    const pipeline = this.redis.pipeline();
    for (const c of connections) {
      pipeline.zadd(RedisPresence.userKey(c.userId), expires, c.socketId);
      pipeline.zadd(RedisPresence.deviceKey(c.deviceId), expires, c.socketId);
      pipeline.pexpire(RedisPresence.userKey(c.userId), PRESENCE_TTL_MS);
      pipeline.pexpire(RedisPresence.deviceKey(c.deviceId), PRESENCE_TTL_MS);
    }
    await pipeline.exec();
  }

  private async live(keys: string[], ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const now = Date.now();
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.zcount(key, now, '+inf');
    const results = (await pipeline.exec()) ?? [];
    return new Set(ids.filter((_, i) => Number(results[i]?.[1] ?? 0) > 0));
  }

  onlineUsers(userIds: string[]): Promise<Set<string>> {
    return this.live(userIds.map(RedisPresence.userKey), userIds);
  }

  onlineDevices(deviceIds: string[]): Promise<Set<string>> {
    return this.live(deviceIds.map(RedisPresence.deviceKey), deviceIds);
  }
}

@Injectable()
export class PresenceStore implements PresenceBackend {
  private readonly backend: PresenceBackend;

  constructor(redis: RedisConnections) {
    this.backend = redis.client ? new RedisPresence(redis.client) : new MemoryPresence();
  }

  connect(c: PresenceConnection): Promise<boolean> {
    return this.backend.connect(c);
  }
  disconnect(c: PresenceConnection): Promise<boolean> {
    return this.backend.disconnect(c);
  }
  heartbeat(connections: PresenceConnection[]): Promise<void> {
    return this.backend.heartbeat(connections);
  }
  onlineUsers(userIds: string[]): Promise<Set<string>> {
    return this.backend.onlineUsers(userIds);
  }
  onlineDevices(deviceIds: string[]): Promise<Set<string>> {
    return this.backend.onlineDevices(deviceIds);
  }
}

export { MemoryPresence, RedisPresence };
