import { describe, expect, it } from 'vitest';
import { formatOgcId, isOgcId, parseOgcId } from './ogc-id.js';

describe('OGC identity format', () => {
  it.each(['OGC000001', 'OGC000042', 'OGC999999', 'OGC1000000', 'OGC123456789'])(
    'accepts canonical identity %s',
    (value) => {
      expect(isOgcId(value)).toBe(true);
      expect(parseOgcId(value)).toBe(value);
    },
  );

  it.each([
    'OGC000000',
    'OGC00001',
    'OGC0000001',
    'ogc000001',
    'OGC-000001',
    ' OGC000001',
    'OGC000001 ',
    'OGC',
    '',
    'OGC00000A',
  ])('rejects non-canonical identity %j', (value) => {
    expect(isOgcId(value)).toBe(false);
    expect(() => parseOgcId(value)).toThrow();
  });

  it('rejects non-string input', () => {
    expect(isOgcId(1)).toBe(false);
    expect(isOgcId(null)).toBe(false);
    expect(() => parseOgcId({})).toThrow();
  });

  it('formats sequence numbers canonically', () => {
    expect(formatOgcId(1)).toBe('OGC000001');
    expect(formatOgcId(999_999)).toBe('OGC999999');
    expect(formatOgcId(1_000_000)).toBe('OGC1000000');
  });

  it('round-trips formatted identities', () => {
    for (const n of [1, 7, 100_000, 999_999, 1_000_000, 54_321_000]) {
      expect(isOgcId(formatOgcId(n))).toBe(true);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses to format invalid sequence %s',
    (n) => {
      expect(() => formatOgcId(n)).toThrow(RangeError);
    },
  );
});
