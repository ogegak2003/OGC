import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.schema.js';

/**
 * Optional Redis connections for state shared across API instances (rate
 * limits, presence, Socket.IO fan-out). Without REDIS_URL — allowed only
 * outside production — every consumer falls back to in-process state, which
 * is correct for a single instance (docs/architecture/realtime.md).
 */
@Injectable()
export class RedisConnections implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisConnections.name);
  private readonly connections: Redis[] = [];
  readonly client: Redis | null;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('REDIS_URL', { infer: true });
    this.client = url ? this.connect(url, 'main') : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * A dedicated connection (Redis pub/sub needs one per subscriber). The caller
   * owns it and must close it, after whatever uses it has shut down.
   */
  duplicate(purpose: string): Redis {
    if (!this.client) throw new Error('Redis is not configured');
    const connection = this.client.duplicate();
    connection.on('error', (error: Error) => {
      this.logger.warn({ purpose, message: error.message }, 'Redis connection error');
    });
    return connection;
  }

  private connect(url: string, purpose: string): Redis {
    return this.track(
      new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true }),
      purpose,
    );
  }

  private track(connection: Redis, purpose: string): Redis {
    // Log the failure, never the URL (it may contain a password).
    connection.on('error', (error: Error) => {
      this.logger.warn({ purpose, message: error.message }, 'Redis connection error');
    });
    this.connections.push(connection);
    return connection;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}

@Global()
@Module({ providers: [RedisConnections], exports: [RedisConnections] })
export class RedisModule {}
