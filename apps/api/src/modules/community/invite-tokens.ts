import { createHash, randomBytes } from 'node:crypto';

/** Prefix that makes invitation tokens recognisable (and greppable in leak scanners). */
export const INVITE_TOKEN_PREFIX = 'ogc_inv_';

/**
 * A new invitation token: 256 random bits, base64url (ADR-034). Only the
 * SHA-256 hash is stored, so a database leak does not expose usable links.
 * Plain SHA-256 is appropriate here: the input has full entropy, so it cannot
 * be brute-forced (unlike passwords).
 */
export function newInviteToken(): { token: string; hash: string } {
  const token = `${INVITE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
