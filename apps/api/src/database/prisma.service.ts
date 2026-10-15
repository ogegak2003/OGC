import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.schema.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Application-wide Prisma client. Connects lazily on first query so the API
 * can start (and report liveness) while the database is still unavailable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) }),
    });
  }

  /** Returns true when the database answers a trivial query. */
  async isReachable(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True when every migration recorded in the database finished. A failed or still-running
   * `prisma migrate deploy` leaves a row without `finished_at` (and without `rolled_back_at`);
   * the API must not report ready on such a schema. False also when the check cannot run.
   */
  async migrationsComplete(): Promise<boolean> {
    try {
      const [row] = await this.$queryRaw<{ unfinished: bigint }[]>`
        SELECT count(*) AS unfinished FROM "_prisma_migrations"
        WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL`;
      return row?.unfinished === 0n;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
