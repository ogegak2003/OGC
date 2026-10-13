import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes } from './bytes.js';

/**
 * React Native's Hermes engine has `crypto.getRandomValues` (via expo-crypto)
 * but no `crypto.subtle`. The only SubtleCrypto operations OGC's MLS stack
 * reaches are inside `@hpke/core`/`@hpke/common`: HMAC-SHA-256 (HKDF-Extract /
 * Expand) and HKDF-SHA-256 `deriveBits` (the DHKEM shared secret). This shim
 * provides exactly those, backed by the audited `@noble/hashes`
 * implementations; every other operation is rejected loudly rather than
 * emulated. It is installed only where no real `crypto.subtle` exists, and its
 * output is tested byte-for-byte against WebCrypto.
 */

type ShimKind = 'HMAC' | 'HKDF';
const keys = new WeakMap<object, { kind: ShimKind; bytes: Uint8Array }>();

function notSupported(operation: string): Promise<never> {
  return Promise.reject(
    new DOMException(
      `crypto.subtle.${operation} is not available on this platform`,
      'NotSupportedError',
    ),
  );
}

function algorithmName(algorithm: unknown): string | undefined {
  if (typeof algorithm === 'string') return algorithm;
  if (typeof algorithm !== 'object' || algorithm === null) return undefined;
  const { name } = algorithm as { name?: unknown };
  return typeof name === 'string' ? name : undefined;
}

function hashName(algorithm: unknown): string | undefined {
  if (typeof algorithm !== 'object' || algorithm === null) return undefined;
  const { hash } = algorithm as { hash?: unknown };
  if (typeof hash === 'string') return hash;
  return algorithmName(hash);
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('Expected a BufferSource');
}

function keyOf(key: unknown, kind: ShimKind): Uint8Array {
  const entry = typeof key === 'object' && key !== null ? keys.get(key) : undefined;
  if (entry?.kind !== kind)
    throw new DOMException('Invalid key for operation', 'InvalidAccessError');
  return entry.bytes;
}

function settle<T>(compute: () => T): Promise<T> {
  try {
    return Promise.resolve(compute());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export const kdfOnlySubtle = {
  importKey(
    format: string,
    keyData: unknown,
    algorithm: unknown,
    _extractable: boolean,
    usages: string[],
  ) {
    const name = algorithmName(algorithm);
    const supported =
      format === 'raw' &&
      ((name === 'HMAC' && hashName(algorithm) === 'SHA-256') || name === 'HKDF');
    if (!supported) return notSupported('importKey');
    const kind: ShimKind = name === 'HMAC' ? 'HMAC' : 'HKDF';
    return settle(() => {
      const key = Object.freeze({
        type: 'secret',
        extractable: false,
        algorithm: kind === 'HMAC' ? { name: 'HMAC', hash: { name: 'SHA-256' } } : { name: 'HKDF' },
        usages: [...usages],
      });
      keys.set(key, { kind, bytes: toBytes(keyData).slice() });
      return key;
    });
  },
  sign(algorithm: unknown, key: unknown, data: unknown) {
    if (algorithmName(algorithm) !== 'HMAC') return notSupported('sign');
    return settle(() => toArrayBuffer(hmac(sha256, keyOf(key, 'HMAC'), toBytes(data))));
  },
  verify(algorithm: unknown, key: unknown, signature: unknown, data: unknown) {
    if (algorithmName(algorithm) !== 'HMAC') return notSupported('verify');
    return settle(() =>
      equalBytes(hmac(sha256, keyOf(key, 'HMAC'), toBytes(data)), toBytes(signature)),
    );
  },
  deriveBits(algorithm: unknown, key: unknown, length: number) {
    if (algorithmName(algorithm) !== 'HKDF' || hashName(algorithm) !== 'SHA-256') {
      return notSupported('deriveBits');
    }
    if (!Number.isInteger(length) || length <= 0 || length % 8 !== 0) {
      return Promise.reject(new DOMException('Invalid length', 'OperationError'));
    }
    const { salt, info } = algorithm as { salt?: unknown; info?: unknown };
    return settle(() =>
      toArrayBuffer(hkdf(sha256, keyOf(key, 'HKDF'), toBytes(salt), toBytes(info), length / 8)),
    );
  },
  generateKey: () => notSupported('generateKey'),
  exportKey: () => notSupported('exportKey'),
  deriveKey: () => notSupported('deriveKey'),
  encrypt: () => notSupported('encrypt'),
  decrypt: () => notSupported('decrypt'),
  digest: () => notSupported('digest'),
  wrapKey: () => notSupported('wrapKey'),
  unwrapKey: () => notSupported('unwrapKey'),
};

/**
 * Installs `kdfOnlySubtle` as `crypto.subtle` when — and only when — the
 * platform has none. Returns whether the shim was installed.
 */
export function installSubtleKdfShim(): boolean {
  const target = globalThis as { crypto?: { subtle?: unknown; getRandomValues?: unknown } };
  if (!target.crypto || typeof target.crypto.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is required before installing the KDF shim');
  }
  if (target.crypto.subtle !== undefined) return false;
  Object.defineProperty(target.crypto, 'subtle', {
    value: kdfOnlySubtle,
    configurable: false,
    enumerable: true,
    writable: false,
  });
  return true;
}
