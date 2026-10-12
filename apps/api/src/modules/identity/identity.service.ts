import { Injectable, Logger } from '@nestjs/common';
import type { OgcId } from '@ogc/types';
import { isUniqueViolation } from '../../database/prisma-errors.js';
import { OgcIdGenerator } from './ogc-id.generator.js';

/** Collisions are rare (space of 900M); repeated collisions indicate a fault, not bad luck. */
export const MAX_OGC_ID_ATTEMPTS = 5;

export class OgcIdAllocationError extends Error {
  constructor() {
    super(`Could not allocate a unique OGC ID after ${MAX_OGC_ID_ATTEMPTS} attempts`);
    this.name = 'OgcIdAllocationError';
  }
}

/**
 * Owns public OGC ID issuance. Uniqueness is guaranteed by the database's
 * unique index; this service retries with a fresh random ID on collision.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(private readonly generator: OgcIdGenerator) {}

  /**
   * Runs `create` with a freshly generated OGC ID, retrying with a new ID if
   * the insert collides with an existing one. `create` must be atomic (e.g. a
   * transaction) so a failed attempt leaves nothing behind.
   */
  async withNewOgcId<T>(create: (ogcId: OgcId) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_OGC_ID_ATTEMPTS; attempt++) {
      try {
        return await create(this.generator.next());
      } catch (error) {
        if (!isUniqueViolation(error, 'ogc_id')) throw error;
        this.logger.warn({ attempt }, 'OGC ID collision; retrying with a new ID');
      }
    }
    throw new OgcIdAllocationError();
  }
}
