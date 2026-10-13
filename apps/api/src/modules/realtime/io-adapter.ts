import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { REALTIME_PATH } from '@ogc/types';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { RedisConnections } from '../../common/redis/redis.module.js';
import type { Env } from '../../config/env.schema.js';

/** Client events are tiny (typing, presence); anything larger is abuse. */
export const REALTIME_MAX_PAYLOAD_BYTES = 16 * 1024;

/** Browser origins allowed to open realtime connections: the API's CORS list plus the web app. */
export function allowedRealtimeOrigins(config: ConfigService<Env, true>): Set<string> {
  const origins = new Set(config.get('CORS_ORIGINS', { infer: true }));
  origins.add(new URL(config.get('WEB_APP_URL', { infer: true })).origin);
  return origins;
}

/**
 * True when `origin` names the server the request was sent to. Native WebSocket
 * stacks (React Native on Android and iOS) send such an Origin, derived from the
 * socket URL. It is not cross-site, and cookie sessions still require an
 * allowlisted Origin (see the gateway), so accepting it keeps the hijacking defence.
 */
export function isSameHostOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Socket.IO server setup: the versioned path, bounded payloads, an Origin
 * allowlist (defence against cross-site WebSocket hijacking with cookies), and
 * the Redis adapter for cross-instance fan-out when Redis is configured.
 */
export class OgcIoAdapter extends IoAdapter {
  private ioServer: Server | undefined;
  private readonly redisClients: Redis[] = [];

  constructor(private readonly appContext: INestApplicationContext) {
    super(appContext);
  }

  /**
   * Shutdown order matters: close the Socket.IO server (which unsubscribes the
   * Redis adapter) before closing the adapter's Redis connections.
   */
  override async dispose(): Promise<void> {
    const server = this.ioServer;
    if (server) {
      await new Promise<void>((resolve) => {
        void server.close(() => {
          resolve();
        });
      });
    }
    // Replies arrive in order: once a PING is answered, the adapter's unsubscribe
    // commands have completed and the connections can close cleanly.
    await Promise.allSettled(this.redisClients.map((client) => client.ping()));
    await Promise.allSettled(this.redisClients.map((client) => client.quit()));
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const config = this.appContext.get<ConfigService<Env, true>>(ConfigService);
    const origins = allowedRealtimeOrigins(config);
    const settings: Partial<ServerOptions> = {
      ...options,
      path: REALTIME_PATH,
      serveClient: false,
      maxHttpBufferSize: REALTIME_MAX_PAYLOAD_BYTES,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      connectTimeout: 10_000,
      cors: { origin: [...origins], credentials: true },
      // Browsers send their page's Origin; native apps send none or the API's own origin.
      // Any other Origin is rejected.
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        callback(
          null,
          origin === undefined || origins.has(origin) || isSameHostOrigin(origin, req.headers.host),
        );
      },
    };
    // Nest's adapter accepts partial options and fills in Socket.IO's defaults.
    const server = super.createIOServer(port, settings as ServerOptions);
    const redis = this.appContext.get(RedisConnections);
    if (redis.enabled) {
      const pub = redis.duplicate('realtime-pub');
      const sub = redis.duplicate('realtime-sub');
      this.redisClients.push(pub, sub);
      server.adapter(createAdapter(pub, sub));
    }
    this.ioServer = server;
    return server;
  }
}
