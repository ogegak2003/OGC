import { describe, expect, it } from 'vitest';
import {
  bridgeConfirmVerificationSchema,
  bridgeCountry,
  bridgeStartVerificationSchema,
  maskPhoneNumber,
  normalizePhoneNumber,
} from './bridge.js';

// Format checks only: these numbers are parsed, never dialled.
describe('OGC Bridge phone numbers', () => {
  it('normalizes Kenyan mobile and landline formats to E.164', () => {
    for (const input of ['0712 345 678', '+254 712 345 678', '254712345678', '712345678']) {
      expect(normalizePhoneNumber(input, 'KE')).toEqual({
        ok: true,
        e164: '+254712345678',
        country: 'KE',
      });
    }
    expect(normalizePhoneNumber('020 2222222', 'KE')).toMatchObject({
      ok: true,
      e164: '+254202222222',
    });
  });

  it('rejects invalid numbers, other countries and unsupported countries', () => {
    expect(normalizePhoneNumber('0712', 'KE')).toEqual({ ok: false, reason: 'INVALID' });
    expect(normalizePhoneNumber('hello', 'KE')).toEqual({ ok: false, reason: 'INVALID' });
    expect(normalizePhoneNumber('+1 202 555 0143', 'KE')).toEqual({
      ok: false,
      reason: 'WRONG_COUNTRY',
    });
    expect(normalizePhoneNumber('+256 772 123456', 'UG')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_COUNTRY',
    });
    expect(normalizePhoneNumber('0'.repeat(40), 'KE')).toEqual({ ok: false, reason: 'INVALID' });
  });

  it('masks all but the country code, first digit and last three digits', () => {
    const masked = maskPhoneNumber('+254712345678');
    // Kenya's national grouping is "712 345678".
    expect(masked).toMatch(/^\+254 7/);
    expect(masked.endsWith('678')).toBe(true);
    expect(masked.replace(/\D/g, '')).toBe('2547678');
    expect(masked.match(/•/g)).toHaveLength(5);
  });

  it('describes supported countries with their calling codes', () => {
    expect(bridgeCountry('KE')).toEqual({ code: 'KE', name: 'Kenya', callingCode: '254' });
    expect(bridgeCountry('ZZ')).toBeUndefined();
  });

  it('requires explicit consent and a 6-digit code', () => {
    expect(
      bridgeStartVerificationSchema.safeParse({
        country: 'KE',
        number: '0712345678',
        consent: false,
      }).success,
    ).toBe(false);
    expect(
      bridgeStartVerificationSchema.safeParse({
        country: 'KE',
        number: '0712345678',
        consent: true,
      }).success,
    ).toBe(true);
    const id = '0d4c9f5e-8a5b-4c1e-9a7d-3f2b1c0e9d8a';
    expect(
      bridgeConfirmVerificationSchema.safeParse({ verificationId: id, code: '12345' }).success,
    ).toBe(false);
    expect(
      bridgeConfirmVerificationSchema.safeParse({ verificationId: id, code: '123456' }).success,
    ).toBe(true);
  });
});
