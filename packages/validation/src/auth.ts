import { z } from 'zod';

/**
 * Shared authentication input rules, used by the API (authoritative) and by
 * clients (early feedback). See docs/security/authentication.md.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;
export const DISPLAY_NAME_MAX_LENGTH = 64;
/** Opaque tokens are 32 random bytes, base64url-encoded (43 characters). */
const OPAQUE_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * Frequently used passwords that satisfy the length rule. Not a substitute for
 * a breached-password check (planned), but blocks the most common choices.
 */
const COMMON_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789abc',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'aaaaaaaaaaaa',
  'abc123abc123',
  'abcdefghijkl',
  'iloveyou1234',
  'letmein12345',
  'password1234',
  'password12345',
  'password123!',
  'passwordpassword',
  'qwerty123456',
  'qwertyuiopas',
  'qwertyuiop12',
  'welcome12345',
  'administrator',
  'changeme1234',
  'football1234',
  'monkey123456',
  'princess1234',
  'sunshine1234',
  'trustno1trustno1',
]);

const CONTROL_CHARS = /\p{Cc}/u;

/** Unicode-normalises a password so the same input hashes identically on every device. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

export const emailSchema = z
  .string()
  .max(EMAIL_MAX_LENGTH * 2)
  .transform(normalizeEmail)
  .pipe(z.email('Enter a valid email address').max(EMAIL_MAX_LENGTH));

/** Password for a new credential: length-based policy, no composition rules (NIST SP 800-63B). */
export const newPasswordSchema = z
  .string()
  .transform(normalizePassword)
  .pipe(
    z
      .string()
      .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
      .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
      .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
        message: 'This password is too common. Choose something less predictable',
      })
      .refine((value) => new Set(value).size >= 5, {
        message: 'This password is too repetitive. Choose something less predictable',
      }),
  );

/** Password presented at login: only bounded, never policy-checked (policies change). */
export const existingPasswordSchema = z
  .string()
  .min(1, 'Enter your password')
  .max(PASSWORD_MAX_LENGTH * 4)
  .transform(normalizePassword);

export const displayNameSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter a display name')
      .max(DISPLAY_NAME_MAX_LENGTH, `Use at most ${DISPLAY_NAME_MAX_LENGTH} characters`)
      .refine((value) => !CONTROL_CHARS.test(value), { message: 'Remove unsupported characters' }),
  );

export const DEVICE_PLATFORMS = ['WEB', 'ANDROID', 'IOS', 'DESKTOP'] as const;

export const deviceInfoSchema = z.strictObject({
  platform: z.enum(DEVICE_PLATFORMS),
  name: z
    .string()
    .max(64)
    .transform((value) => value.trim())
    .refine((value) => !CONTROL_CHARS.test(value))
    .optional(),
});

/** Brand words that make a password guessable in the context of this service. */
const CONTEXT_WORDS = ['ogc', 'obagaglobal', 'obaga'];

/** A password built from the email address or the service name (refused for new passwords). */
export function isContextualPassword(password: string, email: string): boolean {
  const lower = password.toLowerCase();
  const localPart = email.toLowerCase().split('@')[0] ?? '';
  return (
    (localPart.length >= 4 && lower.includes(localPart)) ||
    CONTEXT_WORDS.some((word) => lower.replace(/[^a-z]/g, '') === word)
  );
}

/** `POST /auth/password`: the current password, and a new one meeting the policy. */
export const changePasswordRequestSchema = z
  .strictObject({
    currentPassword: existingPasswordSchema,
    newPassword: newPasswordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'Choose a password different from your current one',
    path: ['newPassword'],
  });

export const registerRequestSchema = z
  .strictObject({
    email: emailSchema,
    password: newPasswordSchema,
    displayName: displayNameSchema,
  })
  .superRefine((value, ctx) => {
    if (isContextualPassword(value.password, value.email)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Your password must not be based on your email address or the service name',
      });
    }
  });

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: existingPasswordSchema,
  device: deviceInfoSchema.optional(),
});

export const refreshRequestSchema = z.strictObject({
  /** Native clients send the refresh token in the body; browsers use an HttpOnly cookie. */
  refreshToken: z.string().max(256).optional(),
});

export const verifyEmailRequestSchema = z.strictObject({
  token: z.string().regex(OPAQUE_SECRET, 'Invalid verification link'),
});

/** Password-reset tokens: `ogc_pr_` + 256-bit secret (the prefix helps secret scanners). */
export const PASSWORD_RESET_TOKEN = /^ogc_pr_[A-Za-z0-9_-]{43}$/;

/** `POST /auth/password/forgot`: always answered the same way, account or not. */
export const forgotPasswordRequestSchema = z.strictObject({ email: emailSchema });

/** `POST /auth/password/reset`: the token from the emailed link and the new password. */
export const resetPasswordRequestSchema = z.strictObject({
  token: z.string().regex(PASSWORD_RESET_TOKEN, 'This reset link is invalid or has expired'),
  newPassword: newPasswordSchema,
});

/**
 * The reset token from what a person pastes: the whole emailed link (token in the fragment,
 * `…/reset-password#token=…`) or the bare token. Undefined when there is none.
 */
export function resetTokenFrom(input: string): string | undefined {
  const text = input.trim();
  if (PASSWORD_RESET_TOKEN.test(text)) return text;
  const match = /[#&?]token=(ogc_pr_[A-Za-z0-9_-]{43})(?:$|[&\s])/.exec(text);
  return match?.[1];
}

/** Staff: suspending or reinstating an account always records why (shown to staff only). */
export const accountStatusChangeSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Give a reason').max(200),
});

export type RegisterRequest = z.input<typeof registerRequestSchema>;
export type RegisterInput = z.output<typeof registerRequestSchema>;
export type LoginRequest = z.input<typeof loginRequestSchema>;
export type LoginInput = z.output<typeof loginRequestSchema>;
export type RefreshRequest = z.input<typeof refreshRequestSchema>;
export type VerifyEmailRequest = z.input<typeof verifyEmailRequestSchema>;
export type ChangePasswordRequest = z.input<typeof changePasswordRequestSchema>;
export type ForgotPasswordRequest = z.input<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.input<typeof resetPasswordRequestSchema>;
export type DeviceInfo = z.output<typeof deviceInfoSchema>;
