import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  type CiphersuiteImpl,
  type CiphersuiteName,
  type CryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from 'ts-mls';
import { makeGenericHpke } from 'ts-mls/crypto/implementation/hpke.js';
import { makeHashImpl } from 'ts-mls/crypto/implementation/noble/makeHashImpl.js';

/**
 * The single MLS ciphersuite OGC uses (RFC 9420 §17.1, suite 0x0003):
 * X25519 key exchange, ChaCha20-Poly1305, SHA-256 and Ed25519 signatures.
 * ChaCha20-Poly1305 needs no hardware AES, so mobile and web behave the same.
 */
export const OGC_CIPHERSUITE: CiphersuiteName =
  'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519';

/**
 * Supplies ts-mls with audited primitives that work on every OGC platform
 * (browsers, Node.js and React Native's Hermes, which has no WebCrypto):
 *
 * - hashing, HKDF, Ed25519 and ChaCha20-Poly1305 from the `@noble` libraries;
 * - HPKE (RFC 9180) from `@hpke/core` with its pure-JS X25519 KEM and ChaCha20 AEAD.
 *
 * This is wiring only — no cryptographic algorithm is implemented here.
 * `@hpke/core` computes HMAC and HKDF through `crypto.subtle`; on Hermes,
 * `installSubtleKdfShim()` provides exactly those operations.
 */
export const ogcCryptoProvider: CryptoProvider = {
  async getCiphersuiteImpl(cs) {
    if (cs.name !== OGC_CIPHERSUITE) {
      throw new Error(`Unsupported ciphersuite: ${cs.name}`);
    }
    const hpkeSuite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const aead = {
      encrypt: (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) =>
        Promise.resolve(chacha20poly1305(key, nonce, aad).encrypt(plaintext)),
      decrypt: (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array) =>
        Promise.resolve(chacha20poly1305(key, nonce, aad).decrypt(ciphertext)),
    };
    return {
      name: cs.name,
      hash: makeHashImpl('SHA-256'),
      kdf: {
        extract: (salt, ikm) => Promise.resolve(extract(sha256, ikm, salt)),
        expand: (prk, info, len) => Promise.resolve(expand(sha256, prk, info, len)),
        size: sha256.outputLen,
      },
      signature: {
        sign: (signKey, message) => Promise.resolve(ed25519.sign(message, signKey)),
        verify: (publicKey, message, signature) =>
          Promise.resolve(ed25519.verify(signature, message, publicKey)),
        keygen: () => {
          const signKey = ed25519.utils.randomSecretKey();
          return Promise.resolve({ signKey, publicKey: ed25519.getPublicKey(signKey) });
        },
      },
      hpke: await makeGenericHpke(cs.hpke, aead, hpkeSuite),
      rng: { randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    };
  },
};

let suitePromise: Promise<CiphersuiteImpl> | undefined;

/** The OGC ciphersuite implementation (created once per process). */
export function ogcSuite(): Promise<CiphersuiteImpl> {
  suitePromise ??= getCiphersuiteImpl(getCiphersuiteFromName(OGC_CIPHERSUITE), ogcCryptoProvider);
  return suitePromise;
}
