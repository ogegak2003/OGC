import { describe, expect, it } from 'vitest';
import { AttachmentIntegrityError, decryptAttachment, encryptAttachment } from './attachments.js';
import { fromBase64, toBase64, utf8 } from './bytes.js';
import { kdfOnlySubtle } from './kdf-subtle-shim.js';
import { safetyNumber } from './safety-number.js';
import { SealedDataError, generateWebSealingKey, rawKeySealer, webCryptoSealer } from './sealed.js';

describe('base64', () => {
  it('round-trips and rejects non-canonical input', () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
      expect(toBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
    }
    expect(() => fromBase64('abc')).toThrow();
    expect(() => fromBase64('ab=c')).toThrow();
    expect(() => fromBase64('YR==')).toThrow();
  });
});

describe('attachment encryption', () => {
  it('encrypts with a fresh key per file and decrypts to the original bytes', () => {
    const file = utf8('%PDF-1.7 confidential contract');
    const a = encryptAttachment(file);
    const b = encryptAttachment(file);
    expect(a.secret.key).not.toBe(b.secret.key);
    expect(new TextDecoder().decode(a.ciphertext)).not.toContain('confidential');
    expect(decryptAttachment(a.ciphertext, a.secret)).toEqual(file);
  });

  it('detects tampering and wrong keys', () => {
    const { ciphertext, secret } = encryptAttachment(utf8('photo bytes'));
    const tampered = ciphertext.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => decryptAttachment(tampered, secret)).toThrow(AttachmentIntegrityError);
    const other = encryptAttachment(utf8('other'));
    expect(() => decryptAttachment(ciphertext, { ...other.secret, digest: secret.digest })).toThrow(
      AttachmentIntegrityError,
    );
  });
});

describe('safety numbers', () => {
  it('is the same on both sides and changes when a device changes', () => {
    const k = () => crypto.getRandomValues(new Uint8Array(32));
    const alice = { ogcId: 'OGC482731905', deviceKeys: [k(), k()] };
    const bob = { ogcId: 'OGC193847562', deviceKeys: [k()] };
    const number = safetyNumber(alice, bob);
    expect(number).toHaveLength(12);
    expect(number.every((group) => /^\d{5}$/.test(group))).toBe(true);
    expect(safetyNumber(bob, alice)).toEqual(number);
    expect(safetyNumber({ ...alice, deviceKeys: [...alice.deviceKeys].reverse() }, bob)).toEqual(
      number,
    );
    expect(safetyNumber({ ...alice, deviceKeys: [...alice.deviceKeys, k()] }, bob)).not.toEqual(
      number,
    );
  });
});

describe('sealed local storage', () => {
  it.each([
    [
      'raw key (mobile)',
      () => Promise.resolve(rawKeySealer(crypto.getRandomValues(new Uint8Array(32)))),
    ],
    [
      'non-extractable WebCrypto key (web)',
      async () => webCryptoSealer(await generateWebSealingKey()),
    ],
  ])('%s: round-trips and binds the record name', async (_name, make) => {
    const sealer = await make();
    const sealed = await sealer.seal(utf8('group state'), 'group:abc');
    expect(new TextDecoder().decode(await sealer.open(sealed, 'group:abc'))).toBe('group state');
    await expect(sealer.open(sealed, 'group:other')).rejects.toThrow(SealedDataError);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(sealer.open(tampered, 'group:abc')).rejects.toThrow(SealedDataError);
  });

  it('web sealing keys cannot be exported', async () => {
    const key = await generateWebSealingKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('KDF-only SubtleCrypto shim (Hermes)', () => {
  it('matches WebCrypto HMAC-SHA-256 exactly', async () => {
    for (const keyLength of [0, 16, 32, 64, 100]) {
      const keyBytes = crypto.getRandomValues(new Uint8Array(keyLength));
      const data = crypto.getRandomValues(new Uint8Array(77));
      const alg = { name: 'HMAC', hash: 'SHA-256' };
      const real = await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
          'raw',
          keyLength ? keyBytes : new Uint8Array(32),
          alg,
          false,
          ['sign'],
        ),
        data,
      );
      const shimmed = await kdfOnlySubtle.sign(
        'HMAC',
        await kdfOnlySubtle.importKey(
          'raw',
          keyLength ? keyBytes : new Uint8Array(32),
          alg,
          false,
          ['sign'],
        ),
        data,
      );
      expect(new Uint8Array(shimmed)).toEqual(new Uint8Array(real));
    }
  });

  it('verifies MACs and refuses every other operation', async () => {
    const key = await kdfOnlySubtle.importKey(
      'raw',
      new Uint8Array(32),
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign', 'verify'],
    );
    const mac = new Uint8Array(await kdfOnlySubtle.sign('HMAC', key, utf8('x')));
    expect(await kdfOnlySubtle.verify('HMAC', key, mac, utf8('x'))).toBe(true);
    expect(await kdfOnlySubtle.verify('HMAC', key, mac, utf8('y'))).toBe(false);
    await expect(
      kdfOnlySubtle.importKey(
        'raw',
        new Uint8Array(32),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        [],
      ),
    ).rejects.toThrow();
    await expect(
      kdfOnlySubtle.importKey('jwk', {}, { name: 'HMAC', hash: 'SHA-256' }, false, []),
    ).rejects.toThrow();
    await expect(kdfOnlySubtle.encrypt()).rejects.toThrow('not available');
    const hkdfKey = await kdfOnlySubtle.importKey('raw', new Uint8Array(32), 'HKDF', false, [
      'deriveBits',
    ]);
    await expect(kdfOnlySubtle.sign('HMAC', hkdfKey, utf8('x'))).rejects.toThrow();
    await expect(kdfOnlySubtle.sign('HMAC', {}, utf8('x'))).rejects.toThrow();
  });

  it('matches WebCrypto HKDF-SHA-256 deriveBits exactly', async () => {
    for (const bits of [8, 256, 512, 1024]) {
      const ikm = crypto.getRandomValues(new Uint8Array(40));
      const params = {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: crypto.getRandomValues(new Uint8Array(32)),
        info: crypto.getRandomValues(new Uint8Array(17)),
      };
      const real = await crypto.subtle.deriveBits(
        params,
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        bits,
      );
      const shimmed = await kdfOnlySubtle.deriveBits(
        params,
        await kdfOnlySubtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        bits,
      );
      expect(new Uint8Array(shimmed)).toEqual(new Uint8Array(real));
    }
    await expect(
      kdfOnlySubtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-1', salt: new Uint8Array(), info: new Uint8Array() },
        {},
        256,
      ),
    ).rejects.toThrow();
  });
});
