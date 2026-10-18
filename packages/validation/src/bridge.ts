import {
  type CountryCode,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';
import { z } from 'zod';
import { uuidSchema } from './messaging.js';
import { ogcIdSchema } from './ogc-id.js';

/**
 * Countries OGC Bridge knows how to onboard. Kept apart from routing code: a country appears
 * here only after its provider route, number rules and disclosures have been reviewed
 * (docs/operations/bridge-country-onboarding.md). The server narrows this further with
 * BRIDGE_COUNTRIES, so listing a country here does not activate it.
 */
export const BRIDGE_COUNTRY_REGISTRY: Readonly<Record<string, { name: string }>> = {
  KE: { name: 'Kenya' },
};

export const BRIDGE_COUNTRY_CODES = Object.keys(BRIDGE_COUNTRY_REGISTRY);

export function bridgeCountry(
  code: string,
): { code: string; name: string; callingCode: string } | undefined {
  const entry = BRIDGE_COUNTRY_REGISTRY[code];
  if (!entry) return undefined;
  return { code, name: entry.name, callingCode: getCountryCallingCode(code as CountryCode) };
}

export type PhoneNumberResult =
  | { ok: true; e164: string; country: string }
  | { ok: false; reason: 'INVALID' | 'WRONG_COUNTRY' | 'UNSUPPORTED_COUNTRY' };

/**
 * Normalizes a number typed for `country` (national or international form) to E.164.
 * Only countries in the registry are accepted; a number from another country is refused
 * rather than silently re-homed.
 */
export function normalizePhoneNumber(input: string, country: string): PhoneNumberResult {
  if (!BRIDGE_COUNTRY_REGISTRY[country]) return { ok: false, reason: 'UNSUPPORTED_COUNTRY' };
  if (input.length > 32) return { ok: false, reason: 'INVALID' };
  const parsed = parsePhoneNumberFromString(input, country as CountryCode);
  if (!parsed?.isValid()) return { ok: false, reason: 'INVALID' };
  if (parsed.country !== country) return { ok: false, reason: 'WRONG_COUNTRY' };
  return { ok: true, e164: parsed.number, country };
}

/**
 * Masks a number for display to its owner: country code, the first national digit and the
 * last three digits stay visible, e.g. "+254 7•• •••678".
 */
export function maskPhoneNumber(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return '••••';
  const national = parsed.formatInternational().replace(`+${parsed.countryCallingCode}`, '').trim();
  const digits = national.replace(/\D/g, '');
  let seen = 0;
  const masked = national.replace(/\d/g, (digit) => {
    seen += 1;
    return seen === 1 || seen > digits.length - 3 ? digit : '•';
  });
  return `+${parsed.countryCallingCode} ${masked}`;
}

const countrySchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Choose a country')
  .refine((code) => Boolean(BRIDGE_COUNTRY_REGISTRY[code]), 'This country is not supported yet');

/** Start linking a number. `consent` must be explicitly true. */
export const bridgeStartVerificationSchema = z.strictObject({
  country: countrySchema,
  number: z.string().trim().min(4, 'Enter a phone number').max(32, 'That number is too long'),
  consent: z.literal(true, { error: 'Agree to the terms to link a number' }),
});
export type BridgeStartVerification = z.infer<typeof bridgeStartVerificationSchema>;

export const BRIDGE_CODE_LENGTH = 6;

export const bridgeConfirmVerificationSchema = z.strictObject({
  verificationId: uuidSchema,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type BridgeConfirmVerification = z.infer<typeof bridgeConfirmVerificationSchema>;

export const bridgePreferencesSchema = z.strictObject({ allowContactCalls: z.boolean() });

/** A call request. The idempotency key makes retries safe: one key, at most one call. */
export const bridgeStartCallSchema = z.strictObject({
  ogcId: ogcIdSchema,
  idempotencyKey: uuidSchema,
});
export type BridgeStartCall = z.infer<typeof bridgeStartCallSchema>;

export const bridgeEligibilityQuerySchema = z.strictObject({ ogcId: ogcIdSchema });
