import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAccessToken,
  createRefreshToken,
  generateSecret,
  hashToken,
  hashesEqual,
  isAccessToken,
  parseRefreshToken,
} from './tokens.js';

describe('opaque tokens', () => {
  it('generates 256-bit base64url secrets', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(generateSecret()).not.toBe(secret);
  });

  it('recognises access tokens', () => {
    expect(isAccessToken(createAccessToken())).toBe(true);
    expect(isAccessToken('ogc_at_short')).toBe(false);
    expect(isAccessToken(createRefreshToken(randomUUID()))).toBe(false);
  });

  it('embeds and recovers the session id from refresh tokens', () => {
    const sessionId = randomUUID();
    expect(parseRefreshToken(createRefreshToken(sessionId))).toEqual({ sessionId });
    expect(parseRefreshToken(createAccessToken())).toBeUndefined();
    expect(parseRefreshToken(`ogc_rt_not-a-uuid_${generateSecret()}`)).toBeUndefined();
  });

  it('hashes deterministically and compares in constant time', () => {
    const token = createAccessToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashesEqual(hashToken(token), hashToken(token))).toBe(true);
    expect(hashesEqual(hashToken(token), hashToken(createAccessToken()))).toBe(false);
    expect(hashesEqual(hashToken(token), 'abcd')).toBe(false);
  });
});
