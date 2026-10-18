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
/** Per account: reset emails at least this far apart, and at most this many per hour. */
export const PASSWORD_RESET_EMAIL_INTERVAL_MS = MINUTE;
export const PASSWORD_RESET_EMAILS_PER_HOUR = 3;
export const PASSWORD_RESET_WINDOW_MS = HOUR;
/**
 * After a rotation, the superseded refresh token (and any issued from it in the meantime) may
 * still refresh for this long: covers a response lost in transit and concurrent refreshes from
 * several tabs. Anchored to the rotation, never extended by grace use; afterwards it is reuse.
 */
export const REFRESH_GRACE_WINDOW_MS = 30_000;
/** At most this many superseded tokens are honoured within one grace window. */
export const REFRESH_GRACE_MAX_TOKENS = 5;
/** Concurrent refreshes losing the compare-and-swap re-read the session this many times. */
export const REFRESH_MAX_ATTEMPTS = 3;
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
  /** Password changes (each attempt costs an Argon2 verification). */
  changePassword: { limit: 5, ttl: 15 * MINUTE },
  /** Listing and signing out sessions. */
  sessions: { limit: 30, ttl: MINUTE },
  /** "Forgot password" requests (each may send an email). */
  forgotPassword: { limit: 5, ttl: 15 * MINUTE },
  /** Reset attempts with a token (each valid one costs an Argon2 hash). */
  resetPassword: { limit: 10, ttl: 15 * MINUTE },
} as const;
