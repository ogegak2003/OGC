import { describe, expect, it } from 'vitest';
import { clientAddress } from './realtime.gateway.js';

describe('clientAddress', () => {
  it('ignores X-Forwarded-For unless proxies are trusted', () => {
    expect(clientAddress('10.0.0.5', '203.0.113.9', 0)).toBe('10.0.0.5');
    expect(clientAddress('10.0.0.5', undefined, 1)).toBe('10.0.0.5');
  });

  it('takes the address added by the outermost trusted proxy', () => {
    expect(clientAddress('10.0.0.5', '203.0.113.9', 1)).toBe('203.0.113.9');
    // A client-forged entry to the left is not trusted.
    expect(clientAddress('10.0.0.5', '198.51.100.1, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.5', '198.51.100.1, 203.0.113.9', 2)).toBe('198.51.100.1');
    expect(clientAddress('10.0.0.5', ['198.51.100.1', '203.0.113.9'], 5)).toBe('198.51.100.1');
  });
});
