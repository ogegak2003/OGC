import { describe, expect, it } from 'vitest';
import {
  OGC_ID_MAX,
  OGC_ID_MIN,
  formatOgcIdForDisplay,
  isOgcId,
  normalizeOgcId,
  ogcIdFromNumber,
  parseOgcId,
} from './ogc-id.js';

describe('OGC ID format', () => {
  it.each(['OGC482731905', 'OGC100000000', 'OGC999999999'])('accepts %s', (value) => {
    expect(isOgcId(value)).toBe(true);
    expect(parseOgcId(value)).toBe(value);
  });

  it.each([
    'OGC000000001', // leading zero
    'OGC48273190', // 8 digits
    'OGC4827319050', // 10 digits
    'ogc482731905', // lowercase prefix
    'OGC 482731905',
    'OGC482731905 ',
    'OGC48273190A',
    'XGC482731905',
    '',
  ])('rejects %j', (value) => {
    expect(isOgcId(value)).toBe(false);
    expect(() => parseOgcId(value)).toThrow();
  });

  it('rejects non-string input', () => {
    expect(isOgcId(482731905)).toBe(false);
    expect(() => parseOgcId(null)).toThrow();
  });
});

describe('normalizeOgcId', () => {
  it.each(['ogc 482 731 905', 'OGC-482-731-905', '  OGC482731905  ', 'Ogc482731905'])(
    'normalises %j',
    (input) => {
      expect(normalizeOgcId(input)).toBe('OGC482731905');
    },
  );

  it('returns undefined for invalid input', () => {
    expect(normalizeOgcId('OGC 123')).toBeUndefined();
    expect(normalizeOgcId('hello')).toBeUndefined();
  });
});

describe('ogcIdFromNumber', () => {
  it('builds canonical IDs at the range bounds', () => {
    expect(ogcIdFromNumber(OGC_ID_MIN)).toBe('OGC100000000');
    expect(ogcIdFromNumber(OGC_ID_MAX)).toBe('OGC999999999');
  });

  it.each([OGC_ID_MIN - 1, OGC_ID_MAX + 1, 1.5, Number.NaN])('rejects %s', (value) => {
    expect(() => ogcIdFromNumber(value)).toThrow(RangeError);
  });
});

describe('formatOgcIdForDisplay', () => {
  it('groups digits in threes', () => {
    expect(formatOgcIdForDisplay(parseOgcId('OGC482731905'))).toBe('OGC 482 731 905');
  });

  it('round-trips through normalizeOgcId', () => {
    const id = parseOgcId('OGC306841127');
    expect(normalizeOgcId(formatOgcIdForDisplay(id))).toBe(id);
  });
});
