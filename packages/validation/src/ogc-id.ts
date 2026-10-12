import type { OgcId } from '@ogc/types';
import { z } from 'zod';

/**
 * Public OGC identity format — see docs/product/ogc-identity.md and ADR-008.
 *
 * `OGC` followed by a **random** 9-digit number with no leading zero
 * (`OGC482731905`). Identities are allocated with a CSPRNG, never sequentially,
 * so they reveal nothing about sign-up order or user count.
 */
export const OGC_ID_PREFIX = 'OGC';
export const OGC_ID_DIGITS = 9;
/** Smallest and largest numeric part (inclusive): 100 000 000 … 999 999 999. */
export const OGC_ID_MIN = 10 ** (OGC_ID_DIGITS - 1);
export const OGC_ID_MAX = 10 ** OGC_ID_DIGITS - 1;

export const OGC_ID_PATTERN = /^OGC[1-9]\d{8}$/;

export const ogcIdSchema = z
  .string()
  .regex(OGC_ID_PATTERN, 'Invalid OGC ID')
  .transform((value) => value as OgcId);

export function isOgcId(value: unknown): value is OgcId {
  return typeof value === 'string' && OGC_ID_PATTERN.test(value);
}

/** Parses an untrusted canonical value into an `OgcId`, throwing on invalid input. */
export function parseOgcId(value: unknown): OgcId {
  return ogcIdSchema.parse(value);
}

/**
 * Normalises human input (`ogc 482 731 905`, `OGC-482-731-905`) to canonical
 * form. Returns `undefined` if the result is not a valid OGC ID.
 */
export function normalizeOgcId(input: string): OgcId | undefined {
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  return isOgcId(compact) ? compact : undefined;
}

/** Builds the canonical OGC ID for a numeric part within the allowed range. */
export function ogcIdFromNumber(value: number): OgcId {
  if (!Number.isSafeInteger(value) || value < OGC_ID_MIN || value > OGC_ID_MAX) {
    throw new RangeError(`OGC ID number must be an integer in [${OGC_ID_MIN}, ${OGC_ID_MAX}]`);
  }
  return `${OGC_ID_PREFIX}${value}` as OgcId;
}

/** Human-friendly grouping for display only: `OGC 482 731 905`. */
export function formatOgcIdForDisplay(id: OgcId): string {
  const digits = id.slice(OGC_ID_PREFIX.length);
  return `${OGC_ID_PREFIX} ${digits.replace(/(\d{3})(?=\d)/g, '$1 ')}`;
}
