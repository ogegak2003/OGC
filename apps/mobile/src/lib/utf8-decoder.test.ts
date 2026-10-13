import { describe, expect, it } from '@jest/globals';
import { Utf8Decoder } from './utf8-decoder';

const samples = ['', 'hello', 'café', '日本語', '👋🏾 emoji ❤️', 'mixed ascii and ünïcödé \n\t'];

describe('Utf8Decoder (fallback for engines without TextDecoder)', () => {
  it('decodes exactly like the standard decoder', () => {
    const encoder = new TextEncoder();
    for (const sample of samples) {
      const bytes = encoder.encode(sample);
      expect(new Utf8Decoder().decode(bytes)).toBe(new TextDecoder().decode(bytes));
    }
  });

  it('rejects malformed input in fatal mode and replaces it otherwise', () => {
    const invalid = [
      new Uint8Array([0xff]),
      new Uint8Array([0xc0, 0x80]), // overlong
      new Uint8Array([0xed, 0xa0, 0x80]), // surrogate
      new Uint8Array([0xe2, 0x82]), // truncated
    ];
    for (const bytes of invalid) {
      expect(() => new Utf8Decoder('utf-8', { fatal: true }).decode(bytes)).toThrow(TypeError);
      expect(new Utf8Decoder().decode(bytes)).toContain('�');
    }
    expect(() => new Utf8Decoder('latin1')).toThrow(RangeError);
  });
});
