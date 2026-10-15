import { describe, expect, it } from 'vitest';
import { acknowledgePeerKeys, reconcilePeerKeys, verifyPeerKeys } from './key-tracking.js';

describe('key-change detection', () => {
  it('trusts the first keys it sees, silently', () => {
    const { record, status } = reconcilePeerKeys(undefined, ['b', 'a']);
    expect(status).toEqual({ state: 'unverified', added: 0 });
    expect(record).toEqual({ keys: ['a', 'b'], verified: null, changed: false });
  });

  it('flags a new device key, and keeps flagging until acknowledged', () => {
    const first = reconcilePeerKeys(undefined, ['a']).record;
    const changed = reconcilePeerKeys(first, ['a', 'new']);
    expect(changed.status).toEqual({ state: 'changed', added: 1 });
    // Still the last accepted keys: the warning survives a restart.
    expect(changed.record).toEqual({ keys: ['a'], verified: null, changed: true });
    expect(reconcilePeerKeys(changed.record, ['a', 'new']).status.state).toBe('changed');
    const accepted = acknowledgePeerKeys(['a', 'new']);
    expect(reconcilePeerKeys(accepted, ['a', 'new']).status).toEqual({
      state: 'unverified',
      added: 0,
    });
  });

  it('clears a verified mark when a key appears, but not when a device leaves', () => {
    const verified = verifyPeerKeys(['a', 'b'], ['12345', '67890']);
    expect(reconcilePeerKeys(verified, ['a', 'b']).status.state).toBe('verified');
    // A device signed out: still verified (it cannot read new messages).
    const fewer = reconcilePeerKeys(verified, ['a']);
    expect(fewer.status.state).toBe('verified');
    expect(fewer.record.verified).toBe('12345 67890');
    // A key substituted (one removed, one new): flagged, verification gone.
    const swapped = reconcilePeerKeys(fewer.record, ['evil']);
    expect(swapped.status).toEqual({ state: 'changed', added: 1 });
    expect(swapped.record.verified).toBeNull();
  });
});
