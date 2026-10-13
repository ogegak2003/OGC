/**
 * A strict UTF-8 `TextDecoder` for JavaScript engines that lack one. Only
 * UTF-8 is supported; with `fatal: true`, malformed input throws (as the
 * standard decoder does) instead of producing replacement characters.
 */
export class Utf8Decoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM = false;

  constructor(label = 'utf-8', options: { fatal?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`Unsupported encoding: ${label}`);
    this.fatal = options.fatal === true;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let out = '';
    let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const fail = (): string => {
      if (this.fatal) throw new TypeError('The encoded data was not valid UTF-8');
      return '�';
    };
    while (i < bytes.length) {
      const b0 = bytes[i] ?? 0;
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        i += 1;
        continue;
      }
      const length =
        b0 >= 0xf0 && b0 <= 0xf4 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc2 && b0 <= 0xdf ? 2 : 0;
      if (length === 0 || i + length > bytes.length) {
        out += fail();
        i += 1;
        continue;
      }
      let code = length === 2 ? b0 & 0x1f : length === 3 ? b0 & 0x0f : b0 & 0x07;
      let valid = true;
      for (let k = 1; k < length; k++) {
        const next = bytes[i + k] ?? 0;
        if ((next & 0xc0) !== 0x80) valid = false;
        code = (code << 6) | (next & 0x3f);
      }
      const min = length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000;
      if (!valid || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        out += fail();
        i += 1;
        continue;
      }
      out += String.fromCodePoint(code);
      i += length;
    }
    return out;
  }
}

export function installUtf8DecoderIfMissing(): boolean {
  const target = globalThis as { TextDecoder?: unknown };
  if (typeof target.TextDecoder === 'function') return false;
  target.TextDecoder = Utf8Decoder;
  return true;
}
