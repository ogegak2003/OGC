import { installSubtleKdfShim } from '@ogc/e2ee';
import * as ExpoCrypto from 'expo-crypto';
import { installUtf8DecoderIfMissing } from './lib/utf8-decoder';

/**
 * Prepares React Native's Hermes runtime for the messaging engine. Must run
 * before anything else (imported first in index.ts):
 *
 * - `crypto.getRandomValues` / `crypto.randomUUID` from the platform CSPRNG (expo-crypto);
 * - the narrow HMAC/HKDF SubtleCrypto shim (Hermes has no WebCrypto);
 * - a UTF-8 `TextDecoder` if the engine lacks one.
 */
export function setupCrypto(): void {
  const target = globalThis as { crypto?: Partial<Crypto> };
  target.crypto ??= {};
  if (typeof target.crypto.getRandomValues !== 'function') {
    Object.defineProperty(target.crypto, 'getRandomValues', {
      value: <T extends ArrayBufferView | null>(array: T): T =>
        ExpoCrypto.getRandomValues(array as never) as T,
    });
  }
  if (typeof target.crypto.randomUUID !== 'function') {
    Object.defineProperty(target.crypto, 'randomUUID', {
      value: () => ExpoCrypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
    });
  }
  installSubtleKdfShim();
  installUtf8DecoderIfMissing();
}

setupCrypto();
