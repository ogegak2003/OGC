import { describe, expect, it } from 'vitest';
import {
  displayNameSchema,
  emailSchema,
  loginRequestSchema,
  newPasswordSchema,
  normalizePassword,
  registerRequestSchema,
  verifyEmailRequestSchema,
} from './auth.js';

const strongPassword = 'correct horse battery staple';

describe('emailSchema', () => {
  it('normalises case and whitespace', () => {
    expect(emailSchema.parse('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });

  it.each(['', 'not-an-email', 'a@', '@example.com', `${'a'.repeat(250)}@example.com`])(
    'rejects %j',
    (value) => {
      expect(emailSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('newPasswordSchema', () => {
  it('accepts a long passphrase without composition rules', () => {
    expect(newPasswordSchema.parse(strongPassword)).toBe(strongPassword);
  });

  it.each([
    ['too short', 'short-pass1'],
    ['too long', 'x'.repeat(129) + 'abcde'],
    ['common', 'Password1234'],
    ['repetitive', 'abababababababab'],
  ])('rejects a %s password', (_label, value) => {
    expect(newPasswordSchema.safeParse(value).success).toBe(false);
  });

  it('applies Unicode NFKC normalisation', () => {
    // U+FB01 LATIN SMALL LIGATURE FI normalises to "fi".
    expect(normalizePassword('ﬁne passphrase here')).toBe('fine passphrase here');
  });
});

describe('displayNameSchema', () => {
  it('trims and collapses whitespace', () => {
    expect(displayNameSchema.parse('  Ada   Lovelace ')).toBe('Ada Lovelace');
  });

  it.each(['', '   ', 'x'.repeat(65), 'bad\u0007name'])('rejects %j', (value) => {
    expect(displayNameSchema.safeParse(value).success).toBe(false);
  });
});

describe('registerRequestSchema', () => {
  const valid = { email: 'ada@example.com', password: strongPassword, displayName: 'Ada' };

  it('accepts a valid registration', () => {
    expect(registerRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects passwords containing the email local part', () => {
    const result = registerRequestSchema.safeParse({
      ...valid,
      email: 'lovelace@example.com',
      password: 'my-lovelace-password',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (no mass assignment)', () => {
    expect(registerRequestSchema.safeParse({ ...valid, status: 'ACTIVE' }).success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('does not apply the new-password policy to existing passwords', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'ada@example.com', password: 'short' }).success,
    ).toBe(true);
  });

  it('validates the optional device descriptor', () => {
    const base = { email: 'ada@example.com', password: 'x' };
    expect(loginRequestSchema.safeParse({ ...base, device: { platform: 'IOS' } }).success).toBe(
      true,
    );
    expect(loginRequestSchema.safeParse({ ...base, device: { platform: 'TOASTER' } }).success).toBe(
      false,
    );
  });
});

describe('verifyEmailRequestSchema', () => {
  it('accepts a 43-character base64url token only', () => {
    expect(verifyEmailRequestSchema.safeParse({ token: 'a'.repeat(43) }).success).toBe(true);
    expect(verifyEmailRequestSchema.safeParse({ token: 'a'.repeat(42) }).success).toBe(false);
    expect(verifyEmailRequestSchema.safeParse({ token: `${'a'.repeat(42)}=` }).success).toBe(false);
  });
});
