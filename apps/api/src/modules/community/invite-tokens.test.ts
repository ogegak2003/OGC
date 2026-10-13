import { INVITE_TOKEN_PATTERN } from '@ogc/validation';
import { describe, expect, it } from 'vitest';
import { hashInviteToken, newInviteToken } from './invite-tokens.js';

describe('invite tokens', () => {
  it('are 256-bit, prefixed and match the shared pattern', () => {
    const { token, hash } = newInviteToken();
    expect(token).toMatch(INVITE_TOKEN_PATTERN);
    expect(Buffer.from(token.slice('ogc_inv_'.length), 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInviteToken(token));
    expect(hash).not.toContain(token.slice(8));
  });

  it('are unique', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newInviteToken().token));
    expect(tokens.size).toBe(1000);
  });
});
