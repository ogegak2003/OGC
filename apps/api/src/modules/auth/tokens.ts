import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque bearer secrets. Tokens carry no data a client can read or forge; the
 * server stores only SHA-256 hashes (adequate for 256-bit random values, unlike
 * passwords), so a database leak does not expose usable tokens.
 *
 * Prefixes make leaked tokens recognisable to secret scanners.
 *   access:        ogc_at_<secret>
 *   refresh:       ogc_rt_<sessionId>_<secret>
 *   verification:  <secret>
 *   password reset: ogc_pr_<secret>
 */
const SECRET_BYTES = 32;
const SECRET = '[A-Za-z0-9_-]{43}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const ACCESS_TOKEN = new RegExp(`^ogc_at_${SECRET}$`);
const REFRESH_TOKEN = new RegExp(`^ogc_rt_(${UUID})_(${SECRET})$`);

export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAccessToken(): string {
  return `ogc_at_${generateSecret()}`;
}

export function isAccessToken(value: string): boolean {
  return ACCESS_TOKEN.test(value);
}

/**
 * The refresh token names its session so that presenting an *old* (already
 * rotated) token is detectable as reuse — a sign the token was stolen.
 */
export function createRefreshToken(sessionId: string): string {
  return `ogc_rt_${sessionId}_${generateSecret()}`;
}

export function parseRefreshToken(value: string): { sessionId: string } | undefined {
  const match = REFRESH_TOKEN.exec(value);
  return match?.[1] ? { sessionId: match[1] } : undefined;
}
