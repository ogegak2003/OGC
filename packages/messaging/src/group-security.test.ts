import { describe, expect, it } from 'vitest';
import { describeGroupSecurity } from './display.js';
import {
  GROUP_SECURITY_EVENTS_MAX,
  type GroupSecurityEvent,
  type GroupSecurityRecord,
  type GroupTransition,
  type TrackedDevice,
  acknowledgeGroup,
  baselineGroup,
  pendingGroupWarnings,
  reconcileGroup,
} from './group-security.js';

const dev = (ogcId: string, n: number, key = `${ogcId}-key-${String(n)}`): TrackedDevice => ({
  ogcId,
  deviceKeyId: `${ogcId}-dev-${String(n)}`,
  key,
});
const byAlice: GroupTransition = { kind: 'commit', committer: { kind: 'member', ogcId: 'alice' } };
const external: GroupTransition = { kind: 'commit', committer: { kind: 'external' } };
const own: GroupTransition = { kind: 'own-commit' };
const join: GroupTransition = { kind: 'join' };

const ME = 'me';
/** The only event a transition added (fails the test when there is not exactly one). */
const only = (added: GroupSecurityEvent[]): GroupSecurityEvent => {
  expect(added).toHaveLength(1);
  const [event] = added;
  if (!event) throw new Error('no event');
  return event;
};
const start = (): GroupSecurityRecord => baselineGroup(1, [dev(ME, 1), dev('alice', 1)]);
const nameOf = (ogcId: string | null) => (ogcId ? ogcId.toUpperCase() : 'Someone');

describe('group security changes', () => {
  it('trusts the first tree it sees, silently', () => {
    const record = start();
    expect(record.events).toEqual([]);
    expect(record.known).toEqual({ alice: ['alice-key-1'], me: ['me-key-1'] });
  });

  it('records a new person joining as a confirmed change, not a warning', () => {
    const { record, added } = reconcileGroup(
      start(),
      2,
      [dev(ME, 1), dev('alice', 1), dev('bob', 1)],
      byAlice,
    );
    expect(added).toEqual([
      expect.objectContaining({
        change: 'member-joined',
        level: 'confirmed',
        ogcId: 'bob',
        via: 'member',
        by: 'alice',
        acknowledged: true,
      }),
    ]);
    expect(pendingGroupWarnings(record.events)).toEqual([]);
    // External joins of new members (the usual way to accept an invitation) are ordinary too.
    const self = reconcileGroup(start(), 2, [dev(ME, 1), dev('alice', 1), dev('bob', 1)], external);
    expect(self.added[0]).toMatchObject({ level: 'confirmed', via: 'self', by: null });
  });

  it('asks for verification when a known member gets a key this device never saw', () => {
    const { record, added } = reconcileGroup(
      start(),
      2,
      [dev(ME, 1), dev('alice', 1), dev('alice', 2)],
      external,
    );
    expect(added).toEqual([
      expect.objectContaining({
        change: 'new-device',
        level: 'verify',
        ogcId: 'alice',
        devices: 1,
      }),
    ]);
    expect(pendingGroupWarnings(record.events)).toHaveLength(1);
    // A key replaced on the same device ID is a new key as well.
    const swapped = reconcileGroup(start(), 2, [dev(ME, 1), dev('alice', 1, 'evil')], byAlice);
    expect(swapped.added[0]).toMatchObject({ change: 'new-device', level: 'verify' });
  });

  it('warns about a new device on this account too', () => {
    const { added } = reconcileGroup(start(), 2, [dev(ME, 1), dev(ME, 2), dev('alice', 1)], own);
    expect(added[0]).toMatchObject({
      change: 'new-device',
      ogcId: ME,
      level: 'verify',
      via: 'you',
    });
    expect(describeGroupSecurity(only(added), nameOf, ME)).toMatch(/your account/);
  });

  it('accepts removed devices silently and records a person leaving as confirmed', () => {
    const two = reconcileGroup(start(), 2, [dev(ME, 1), dev('alice', 1), dev('alice', 2)], own);
    const fewer = reconcileGroup(
      acknowledgeGroup(two.record),
      3,
      [dev(ME, 1), dev('alice', 1)],
      own,
    );
    expect(fewer.added).toEqual([]);
    const gone = reconcileGroup(fewer.record, 4, [dev(ME, 1)], byAlice);
    expect(gone.added).toEqual([
      expect.objectContaining({ change: 'member-left', level: 'confirmed', ogcId: 'alice' }),
    ]);
    expect(pendingGroupWarnings(gone.record.events)).toEqual([]);
  });

  it('ignores duplicate, retried and out-of-order commits', () => {
    const tree = [dev(ME, 1), dev('alice', 1), dev('alice', 2)];
    const first = reconcileGroup(start(), 2, tree, byAlice);
    expect(first.added).toHaveLength(1);
    // The same commit again (retry, reconnect, duplicate realtime event).
    expect(reconcileGroup(first.record, 2, tree, byAlice)).toEqual({
      record: first.record,
      added: [],
    });
    // An older epoch arriving late, even with a different tree, changes nothing.
    const late = reconcileGroup(first.record, 1, [dev(ME, 1), dev('mallory', 1)], byAlice);
    expect(late).toEqual({ record: first.record, added: [] });
    // Re-applying the same state at a later epoch adds no event either.
    expect(reconcileGroup(first.record, 3, tree, own).added).toEqual([]);
  });

  it('marks changes learned by rejoining as unconfirmed', () => {
    const { record, added } = reconcileGroup(start(), 7, [dev(ME, 1), dev('bob', 1)], join);
    expect(added.map((e) => [e.change, e.level, e.ogcId])).toEqual([
      ['member-joined', 'unconfirmed', 'bob'],
      ['member-left', 'unconfirmed', 'alice'],
      ['resynced', 'unconfirmed', null],
    ]);
    expect(pendingGroupWarnings(record.events)).toHaveLength(3);
    // The same rejoin processed twice is recorded once.
    expect(reconcileGroup(record, 7, [dev(ME, 1), dev('bob', 1)], join).added).toEqual([]);
    for (const event of added) {
      expect(describeGroupSecurity(event, nameOf, ME)).toMatch(/couldn’t be checked|not checked/);
    }
  });

  it('remembers keys of people who left: same key back is a join, a new key needs checking', () => {
    const gone = reconcileGroup(start(), 2, [dev(ME, 1)], byAlice).record;
    const back = reconcileGroup(gone, 3, [dev(ME, 1), dev('alice', 1)], byAlice);
    expect(back.added[0]).toMatchObject({ change: 'member-joined', level: 'confirmed' });
    const changed = reconcileGroup(gone, 3, [dev(ME, 1), dev('alice', 9)], byAlice);
    expect(changed.added[0]).toMatchObject({ change: 'new-device', level: 'verify' });
  });

  it('keeps warnings until acknowledged, then only the accepted keys count', () => {
    const tree = [dev(ME, 1), dev('alice', 1), dev('alice', 2)];
    const warned = reconcileGroup(start(), 2, tree, byAlice).record;
    const seen = acknowledgeGroup(warned);
    expect(pendingGroupWarnings(seen.events)).toEqual([]);
    expect(reconcileGroup(seen, 3, tree, own).added).toEqual([]);
  });

  it('bounds the stored history', () => {
    let record = start();
    for (let epoch = 2; epoch < GROUP_SECURITY_EVENTS_MAX + 20; epoch++) {
      const members = [dev(ME, 1), dev('alice', 1)];
      if (epoch % 2 === 0) members.push(dev(`p${String(epoch)}`, 1));
      record = reconcileGroup(record, epoch, members, byAlice).record;
    }
    expect(record.events.length).toBeLessThanOrEqual(GROUP_SECURITY_EVENTS_MAX);
  });

  it('words changes by what the device knows, never as a proven attack', () => {
    const newKey = only(
      reconcileGroup(start(), 2, [dev(ME, 1), dev('alice', 1), dev('alice', 2)], byAlice).added,
    );
    const text = describeGroupSecurity(newKey, nameOf, ME);
    expect(text).toMatch(/ALICE has a new security key/);
    expect(text).toMatch(/compare safety numbers/);
    expect(text).not.toMatch(/attack|hacked|compromised|verified/i);
    const joined = only(
      reconcileGroup(start(), 2, [dev(ME, 1), dev('alice', 1), dev('bob', 1)], byAlice).added,
    );
    expect(describeGroupSecurity(joined, nameOf, ME)).toBe(
      'ALICE’s device added BOB to the group’s encryption.',
    );
    // Nothing secret is part of an event.
    expect(JSON.stringify(newKey)).not.toContain('alice-key');
  });
});
