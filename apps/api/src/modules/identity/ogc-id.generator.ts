import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OgcId } from '@ogc/types';
import { OGC_ID_MAX, OGC_ID_MIN, ogcIdFromNumber } from '@ogc/validation';

/** Returns a uniformly distributed integer in [min, maxExclusive). Must be cryptographically secure. */
export type RandomIntSource = (min: number, maxExclusive: number) => number;

export const RANDOM_INT_SOURCE = Symbol('RANDOM_INT_SOURCE');

/** Node's CSPRNG-backed, rejection-sampled (unbiased) integer generator. */
export const secureRandomInt: RandomIntSource = (min, maxExclusive) => randomInt(min, maxExclusive);

/**
 * Generates candidate public OGC IDs. Each ID is drawn independently from the
 * full 9-digit space — no counters, timestamps, or user data are involved.
 */
@Injectable()
export class OgcIdGenerator {
  constructor(@Inject(RANDOM_INT_SOURCE) private readonly random: RandomIntSource) {}

  next(): OgcId {
    return ogcIdFromNumber(this.random(OGC_ID_MIN, OGC_ID_MAX + 1));
  }
}
