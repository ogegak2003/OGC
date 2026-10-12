import type { OgcId } from '@ogc/types';
import { z } from 'zod';

/**
 * Canonical OGC identity format (provisional — see docs/product/ogc-identity.md).
 *
 * `OGC` followed by the sequence number, zero-padded to six digits
 * (`OGC000001` … `OGC999999`). Numbers beyond 999 999 use their natural
 * width without leading zeros (`OGC1000000`), so every number has exactly
 * one canonical representation. `OGC000000` is not a valid identity.
 */
export const OGC_ID_PATTERN = /^OGC(?!000000$)(?:\d{6}|[1-9]\d{6,})$/;

export const ogcIdSchema = z
  .string()
  .regex(OGC_ID_PATTERN, 'Invalid OGC identity')
  .transform((value) => value as OgcId);

export function isOgcId(value: unknown): value is OgcId {
  return typeof value === 'string' && OGC_ID_PATTERN.test(value);
}

/** Parses an untrusted value into an `OgcId`, throwing on invalid input. */
export function parseOgcId(value: unknown): OgcId {
  return ogcIdSchema.parse(value);
}

/** Formats a positive integer sequence number as its canonical `OgcId`. */
export function formatOgcId(sequence: number): OgcId {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('OGC sequence number must be a positive safe integer');
  }
  return `OGC${String(sequence).padStart(6, '0')}` as OgcId;
}
