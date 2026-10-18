import { describe, expect, it } from 'vitest';
import { TransportError, parseRetryAfter } from './transport.js';

describe('Retry-After handling', () => {
  it('parses whole seconds and ignores anything else', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter(' 5 ')).toBe(5);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('1.5')).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
  });

  it('keeps the value on the transport error, and 429s stay retryable', () => {
    const error = new TransportError('Try later', 429, 'MLS_RESYNC_RATE_LIMITED', 30);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.retryable).toBe(true);
    expect(new TransportError('Gone', 404).retryAfterSeconds).toBeUndefined();
  });
});
