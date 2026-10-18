import { parsePhoneNumberFromString as parsePhoneNumber } from 'libphonenumber-js/max';

/**
 * Toll-fraud protection: which numbers OGC Bridge may ever dial. Uses the full number-type
 * metadata (server only). Allowed: ordinary mobile and fixed-line numbers in an enabled
 * country, never on the operator's blocked-prefix list. Premium-rate, shared-cost, toll-free,
 * personal, pager, UAN, voicemail and unknown types are refused.
 */
const ALLOWED_TYPES = new Set(['MOBILE', 'FIXED_LINE', 'FIXED_LINE_OR_MOBILE']);

export type DestinationVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'COUNTRY_NOT_ENABLED' | 'NUMBER_TYPE' | 'BLOCKED_PREFIX' | 'INVALID';
    };

export function checkDestination(
  e164: string,
  enabledCountries: readonly string[],
  blockedPrefixes: readonly string[],
): DestinationVerdict {
  const parsed = parsePhoneNumber(e164);
  if (!parsed?.isValid() || parsed.number !== e164) return { allowed: false, reason: 'INVALID' };
  if (!parsed.country || !enabledCountries.includes(parsed.country)) {
    return { allowed: false, reason: 'COUNTRY_NOT_ENABLED' };
  }
  if (blockedPrefixes.some((prefix) => e164.startsWith(prefix))) {
    return { allowed: false, reason: 'BLOCKED_PREFIX' };
  }
  const type = parsed.getType();
  if (!type || !ALLOWED_TYPES.has(type)) return { allowed: false, reason: 'NUMBER_TYPE' };
  return { allowed: true };
}

/** Numbers that can receive an SMS verification code. */
export function canReceiveCodes(e164: string): boolean {
  const type = parsePhoneNumber(e164)?.getType();
  return type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
}
