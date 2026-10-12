const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short-lived bearer credential; renewed through the refresh flow. */
export const ACCESS_TOKEN_TTL_MS = 15 * MINUTE;
/** Absolute session lifetime; after this the user must sign in again. */
export const SESSION_TTL_MS = 30 * DAY;
export const VERIFICATION_TOKEN_TTL_MS = DAY;
/** Minimum gap between verification emails for one account. */
export const VERIFICATION_RESEND_INTERVAL_MS = MINUTE;
/** Session/device "last used" timestamps are written at most this often. */
export const LAST_USED_WRITE_INTERVAL_MS = 5 * MINUTE;

/** Failed-login protection: lock the credential after this many consecutive failures… */
export const LOCKOUT_THRESHOLD = 10;
/** …for this long. Lockouts return the same generic error as a wrong password. */
export const LOCKOUT_DURATION_MS = 15 * MINUTE;

/** Per-client-IP rate limits for authentication endpoints (`@nestjs/throttler`). */
export const AUTH_RATE_LIMITS = {
  register: { limit: 10, ttl: HOUR },
  login: { limit: 10, ttl: MINUTE },
  refresh: { limit: 60, ttl: MINUTE },
  verifyEmail: { limit: 20, ttl: HOUR },
  resendVerification: { limit: 5, ttl: HOUR },
} as const;
