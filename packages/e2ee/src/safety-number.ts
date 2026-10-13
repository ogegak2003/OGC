import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, toHex, utf8 } from './bytes.js';

/**
 * Safety numbers let two people confirm, out of band, that they are talking to
 * each other's real devices and not to keys substituted by the server.
 * The construction follows Signal's numeric fingerprint (iterated SHA-512 over
 * a version, the account identifier and its keys, 5 digits per 5 bytes),
 * extended to cover every device of each account. The number changes whenever
 * either person adds or removes a device.
 */
export interface SafetyNumberParty {
  ogcId: string;
  /** Ed25519 signature public keys of every active device of the account. */
  deviceKeys: Uint8Array[];
}

const VERSION = utf8('ogc-safety-number/v1');
const ITERATIONS = 5200;

function fingerprint(party: SafetyNumberParty): string {
  const keys = [...party.deviceKeys].sort((a, b) => toHex(a).localeCompare(toHex(b)));
  const encodedKeys = concatBytes(...keys);
  let hash = sha512(concatBytes(VERSION, utf8(party.ogcId), encodedKeys));
  for (let i = 1; i < ITERATIONS; i++) hash = sha512(concatBytes(hash, encodedKeys));
  let digits = '';
  for (let chunk = 0; chunk < 6; chunk++) {
    let value = 0;
    for (let b = 0; b < 5; b++) value = value * 256 + (hash[chunk * 5 + b] ?? 0);
    digits += String(value % 100_000).padStart(5, '0');
  }
  return digits;
}

/**
 * Returns the 60-digit safety number for two accounts, in 12 groups of five.
 * Both sides compute the same number regardless of who is "local".
 */
export function safetyNumber(a: SafetyNumberParty, b: SafetyNumberParty): string[] {
  const parts = [fingerprint(a), fingerprint(b)].sort();
  const all = parts.join('');
  return all.match(/\d{5}/g) ?? [];
}
