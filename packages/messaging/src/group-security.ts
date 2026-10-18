/**
 * Group security changes, derived on this device from the MLS ratchet tree (never from server
 * metadata). The device remembers the tree it last accepted for each group and, every time the
 * group state moves on, compares the new tree with it:
 *
 * - `confirmed` — an ordinary membership change (someone joined or left) seen in an MLS commit
 *   this device verified itself. Every member's group state contains it. Informational.
 * - `verify` — someone already in (or previously in) the group, or this account, now has a
 *   device signature key this device never saw in the group. The MLS commit is authentic, but
 *   only the server vouches that the key belongs to that person: it may be their new device or
 *   a substituted key. Comparing safety numbers settles it.
 * - `unconfirmed` — this device had to rejoin the group (it was offline across changes it
 *   could not verify, or was re-added). The changes in between were not checked one by one;
 *   only the resulting membership is known.
 *
 * Removing a device of a person who stays is accepted silently, as for direct conversations:
 * a removed device cannot read new messages.
 */

/** A device in the group's MLS tree. */
export interface TrackedDevice {
  ogcId: string;
  deviceKeyId: string;
  /** Base64 signature public key from the leaf. */
  key: string;
}

export type GroupSecurityLevel = 'confirmed' | 'verify' | 'unconfirmed';

export type GroupSecurityChange =
  /** A person new to this group joined. */
  | 'member-joined'
  /** A person's last device left the group (they left or were removed). */
  | 'member-left'
  /** A device key never seen in this group appeared for someone already known to it. */
  | 'new-device'
  /** This device rejoined: the changes since it last saw the group could not be verified. */
  | 'resynced';

export interface GroupSecurityEvent {
  /** Deterministic (epoch, change, account): the same change is never recorded twice. */
  id: string;
  /** MLS epoch of the group state the change was observed in. */
  epoch: number;
  change: GroupSecurityChange;
  level: GroupSecurityLevel;
  /** The account concerned (null for `resynced`). */
  ogcId: string | null;
  /** Devices concerned (new keys for `new-device`, devices that joined for `member-joined`). */
  devices: number;
  /**
   * Who made the change, from the verified commit: an account's device (`member`), the joining
   * device itself (`self` — an external join), this device (`you`), or unknown (`rejoin`).
   */
  via: 'member' | 'self' | 'you' | 'rejoin';
  /** The committing account when `via` is `member`. */
  by: string | null;
  /** Only `verify` and `unconfirmed` changes need attention; `confirmed` ones start acknowledged. */
  acknowledged: boolean;
}

export interface GroupSecurityRecord {
  /** Epoch of the last accepted tree. */
  epoch: number;
  devices: TrackedDevice[];
  /** Every signature key accepted per account in this group (kept when they leave). */
  known: Record<string, string[]>;
  events: GroupSecurityEvent[];
}

/** How the group state changed on this device. */
export type GroupTransition =
  /** A commit by another device, verified by this device. */
  | { kind: 'commit'; committer: { kind: 'member'; ogcId: string } | { kind: 'external' } }
  /** A commit made by this device (adding or removing devices from the directory). */
  | { kind: 'own-commit' }
  /** This device joined from a Welcome or an external join (its first state, or a rejoin). */
  | { kind: 'join' };

/** Events kept per group on this device. */
export const GROUP_SECURITY_EVENTS_MAX = 100;

const byAccount = (devices: readonly TrackedDevice[]): Map<string, TrackedDevice[]> => {
  const map = new Map<string, TrackedDevice[]>();
  for (const device of devices) map.set(device.ogcId, [...(map.get(device.ogcId) ?? []), device]);
  return map;
};

function remember(
  known: Record<string, string[]>,
  devices: readonly TrackedDevice[],
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...known };
  for (const device of devices) {
    const keys = new Set(next[device.ogcId] ?? []);
    keys.add(device.key);
    next[device.ogcId] = [...keys].sort();
  }
  return next;
}

/** A record trusting `devices` as they are (first sight of the group on this device). */
export function baselineGroup(
  epoch: number,
  devices: readonly TrackedDevice[],
): GroupSecurityRecord {
  return { epoch, devices: [...devices], known: remember({}, devices), events: [] };
}

/**
 * Compares the tree after a transition with the stored record; returns the record to store and
 * the events that are new. Idempotent: replaying the same state adds nothing.
 */
export function reconcileGroup(
  stored: GroupSecurityRecord,
  epoch: number,
  devices: readonly TrackedDevice[],
  transition: GroupTransition,
): { record: GroupSecurityRecord; added: GroupSecurityEvent[] } {
  // A commit can only move the group forward; an older or repeated epoch is a duplicate.
  if (transition.kind !== 'join' && epoch <= stored.epoch) return { record: stored, added: [] };

  const gap = transition.kind === 'join';
  const via: GroupSecurityEvent['via'] = gap
    ? 'rejoin'
    : transition.kind === 'own-commit'
      ? 'you'
      : transition.committer.kind === 'member'
        ? 'member'
        : 'self';
  const by =
    transition.kind === 'commit' && transition.committer.kind === 'member'
      ? transition.committer.ogcId
      : null;

  const before = byAccount(stored.devices);
  const after = byAccount(devices);
  const candidates: Omit<GroupSecurityEvent, 'id' | 'acknowledged'>[] = [];
  const event = (
    change: GroupSecurityChange,
    level: GroupSecurityLevel,
    ogcId: string | null,
    count: number,
  ) => candidates.push({ epoch, change, level, ogcId, devices: count, via, by });

  for (const [ogcId, now] of after) {
    const accepted = new Set(stored.known[ogcId] ?? []);
    const unseen = now.filter((device) => !accepted.has(device.key)).length;
    if (unseen > 0 && ogcId in stored.known) event('new-device', 'verify', ogcId, unseen);
    else if (!before.has(ogcId)) {
      event('member-joined', gap ? 'unconfirmed' : 'confirmed', ogcId, now.length);
    }
  }
  for (const ogcId of before.keys()) {
    if (!after.has(ogcId)) event('member-left', gap ? 'unconfirmed' : 'confirmed', ogcId, 0);
  }
  if (gap) event('resynced', 'unconfirmed', null, 0);

  const existing = new Set(stored.events.map((e) => e.id));
  const added = candidates
    .map((c) => ({
      ...c,
      id: `${c.epoch}:${c.change}:${c.ogcId ?? ''}`,
      acknowledged: c.level === 'confirmed',
    }))
    .filter((e) => !existing.has(e.id));
  return {
    record: {
      epoch,
      devices: [...devices],
      known: remember(stored.known, devices),
      events: [...stored.events, ...added].slice(-GROUP_SECURITY_EVENTS_MAX),
    },
    added,
  };
}

/** Marks every change as seen (the person dismissed the warning). */
export function acknowledgeGroup(stored: GroupSecurityRecord): GroupSecurityRecord {
  return { ...stored, events: stored.events.map((e) => ({ ...e, acknowledged: true })) };
}

/** Changes that still need the person's attention, oldest first. */
export function pendingGroupWarnings(events: readonly GroupSecurityEvent[]): GroupSecurityEvent[] {
  return events.filter((e) => !e.acknowledged && e.level !== 'confirmed');
}
