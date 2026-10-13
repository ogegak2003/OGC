import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, fromBase64, toBase64, utf8, wipe } from './bytes.js';

/**
 * Attachment encryption (ADR-027). Each file gets a fresh random 256-bit key
 * and is sealed with XChaCha20-Poly1305 before upload, so the server stores
 * only ciphertext. The key, nonce and ciphertext digest travel inside the
 * MLS-encrypted message, never to the server in the clear.
 */
export interface AttachmentSecret {
  /** base64 256-bit key. */
  key: string;
  /** base64 192-bit nonce. */
  nonce: string;
  /** base64 SHA-256 of the ciphertext, checked before decryption. */
  digest: string;
}

const AAD = utf8('ogc-attachment/v1');

export class AttachmentIntegrityError extends Error {
  override readonly name = 'AttachmentIntegrityError';
}

export function encryptAttachment(plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  secret: AttachmentSecret;
} {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ciphertext = xchacha20poly1305(key, nonce, AAD).encrypt(plaintext);
  const secret = {
    key: toBase64(key),
    nonce: toBase64(nonce),
    digest: toBase64(sha256(ciphertext)),
  };
  wipe(key);
  return { ciphertext, secret };
}

export function decryptAttachment(ciphertext: Uint8Array, secret: AttachmentSecret): Uint8Array {
  if (!equalBytes(sha256(ciphertext), fromBase64(secret.digest))) {
    throw new AttachmentIntegrityError('Attachment does not match its digest');
  }
  const key = fromBase64(secret.key);
  const nonce = fromBase64(secret.nonce);
  if (key.length !== 32 || nonce.length !== 24) {
    throw new AttachmentIntegrityError('Invalid attachment key');
  }
  try {
    return xchacha20poly1305(key, nonce, AAD).decrypt(ciphertext);
  } catch {
    throw new AttachmentIntegrityError('Attachment failed authentication');
  } finally {
    wipe(key);
  }
}
