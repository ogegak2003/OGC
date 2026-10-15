/**
 * Key-change detection for direct conversations (Phase 8). Each person's device signature keys
 * are remembered on this device the first time they are seen (trust on first use). When a key
 * that was never seen before appears — a new or reinstalled device, or a key substituted by a
 * malicious server — the conversation is flagged until the person acknowledges it or verifies
 * the safety number again; a previous "verified" mark is cleared. Removed keys (a device signed
 * out) are accepted silently: they cannot be used to read new messages.
 *
 * This only detects changes between what this device saw before and now. It cannot tell a
 * legitimate new device from an attack — comparing safety numbers in person can.
 */

export interface PeerKeyRecord {
  /** Base64 device signature keys last accepted for this person (sorted). */
  keys: string[];
  /** The safety number (groups joined by spaces) the person was verified with, if any. */
  verified: string | null;
  /** Keys appeared that were never accepted: shown as a warning until acknowledged. */
  changed: boolean;
}

export type PeerKeyState = 'unverified' | 'verified' | 'changed';

export interface PeerKeyStatus {
  state: PeerKeyState;
  /** Keys seen now that were not accepted before (only when `changed`). */
  added: number;
}

const sorted = (keys: string[]) => [...new Set(keys)].sort();

/** Compares the keys seen now with the stored record; returns the record to store. */
export function reconcilePeerKeys(
  stored: PeerKeyRecord | undefined,
  current: string[],
): { record: PeerKeyRecord; status: PeerKeyStatus } {
  const now = sorted(current);
  if (!stored) {
    return {
      record: { keys: now, verified: null, changed: false },
      status: { state: 'unverified', added: 0 },
    };
  }
  const known = new Set(stored.keys);
  const added = now.filter((key) => !known.has(key)).length;
  if (added > 0 || stored.changed) {
    // Keep the last accepted keys until the person acknowledges or re-verifies.
    const record: PeerKeyRecord = { keys: stored.keys, verified: null, changed: true };
    return { record, status: { state: 'changed', added: Math.max(added, 1) } };
  }
  // Only removals (or nothing): accept the current set as is.
  const record: PeerKeyRecord = { keys: now, verified: stored.verified, changed: false };
  return {
    record,
    status: { state: stored.verified ? 'verified' : 'unverified', added: 0 },
  };
}

/** The person saw the change and accepted the current keys (without verifying). */
export function acknowledgePeerKeys(current: string[]): PeerKeyRecord {
  return { keys: sorted(current), verified: null, changed: false };
}

/** The person compared the safety number in person: remember the keys and the number. */
export function verifyPeerKeys(current: string[], safetyNumber: string[]): PeerKeyRecord {
  return { keys: sorted(current), verified: safetyNumber.join(' '), changed: false };
}
