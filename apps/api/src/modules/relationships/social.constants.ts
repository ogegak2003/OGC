const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Per-account rate limits for social endpoints (`OgcThrottlerGuard` tracks
 * signed-in requests by account, not IP). Discovery is the tightest: exact
 * lookups only, so a person needs a handful per minute, an enumerator millions.
 */
export const SOCIAL_RATE_LIMITS = {
  discovery: { limit: 20, ttl: MINUTE },
  profileView: { limit: 60, ttl: MINUTE },
  avatarView: { limit: 300, ttl: MINUTE },
  profileUpdate: { limit: 30, ttl: HOUR },
  avatarUpload: { limit: 10, ttl: HOUR },
  contactRequest: { limit: 30, ttl: HOUR },
  contactAction: { limit: 120, ttl: MINUTE },
  block: { limit: 60, ttl: HOUR },
  report: { limit: 10, ttl: HOUR },
} as const;

/** After a request is declined, the sender must wait this long to ask again. */
export const DECLINED_REQUEST_COOLDOWN_MS = 7 * DAY;
