import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, utf8 } from './bytes.js';

/**
 * Encryption at rest for everything a device keeps locally (MLS state, private
 * key packages, decrypted message history). `context` names the record and is
 * authenticated, so a sealed value cannot be swapped into another slot.
 */
export interface Sealer {
  seal(plaintext: Uint8Array, context: string): Promise<Uint8Array>;
  open(sealed: Uint8Array, context: string): Promise<Uint8Array>;
}

export class SealedDataError extends Error {
  override readonly name = 'SealedDataError';
}

/**
 * Mobile: a random 256-bit key held in the platform keystore (iOS Keychain /
 * Android Keystore via expo-secure-store) seals data with XChaCha20-Poly1305.
 */
export function rawKeySealer(key: Uint8Array): Sealer {
  if (key.length !== 32) throw new Error('Sealing key must be 32 bytes');
  const ownKey = key.slice();
  return {
    seal(plaintext, context) {
      const nonce = crypto.getRandomValues(new Uint8Array(24));
      const sealed = xchacha20poly1305(ownKey, nonce, utf8(context)).encrypt(plaintext);
      return Promise.resolve(concatBytes(nonce, sealed));
    },
    open(sealed, context) {
      if (sealed.length < 24 + 16)
        return Promise.reject(new SealedDataError('Sealed value too short'));
      try {
        const plain = xchacha20poly1305(ownKey, sealed.subarray(0, 24), utf8(context)).decrypt(
          sealed.subarray(24),
        );
        return Promise.resolve(plain);
      } catch {
        return Promise.reject(new SealedDataError('Sealed value failed authentication'));
      }
    },
  };
}

/**
 * Web: a non-extractable AES-256-GCM `CryptoKey` kept in IndexedDB. Script on
 * the page can use it but can never read its bytes, so stored data cannot be
 * exfiltrated and decrypted elsewhere.
 */
export function webCryptoSealer(key: CryptoKey): Sealer {
  return {
    async seal(plaintext, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8(context) },
        key,
        new Uint8Array(plaintext),
      );
      return concatBytes(iv, new Uint8Array(sealed));
    },
    async open(sealed, context) {
      if (sealed.length < 12 + 16) throw new SealedDataError('Sealed value too short');
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: utf8(context) },
          key,
          sealed.slice(12),
        );
        return new Uint8Array(plain);
      } catch {
        throw new SealedDataError('Sealed value failed authentication');
      }
    },
  };
}

export function generateWebSealingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
