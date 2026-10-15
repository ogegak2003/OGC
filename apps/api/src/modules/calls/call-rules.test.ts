import { describe, expect, it } from 'vitest';
import {
  type CallSnapshot,
  authorize,
  blockedDuringCall,
  deviceLost,
  durationSeconds,
  hangUp,
  requiredDevices,
  timedOut,
} from './call-rules.js';

const caller = { userId: 'caller', deviceId: 'caller-phone' };
const callerLaptop = { userId: 'caller', deviceId: 'caller-laptop' };
const callee = { userId: 'callee', deviceId: 'callee-phone' };
const calleeTablet = { userId: 'callee', deviceId: 'callee-tablet' };
const stranger = { userId: 'mallory', deviceId: 'mallory-phone' };

const ringing: CallSnapshot = {
  status: 'RINGING',
  callerId: 'caller',
  calleeId: 'callee',
  callerDeviceId: 'caller-phone',
  calleeDeviceId: null,
  hiddenFromCallee: false,
  connectedAt: null,
};
const accepted: CallSnapshot = { ...ringing, status: 'ACCEPTED', calleeDeviceId: 'callee-phone' };
const connected: CallSnapshot = { ...accepted, connectedAt: new Date(1_000) };
const ended: CallSnapshot = { ...connected, status: 'ENDED' };

describe('call authorization', () => {
  it('treats non-participants exactly like a call that does not exist', () => {
    for (const command of ['accept', 'decline', 'cancel', 'end', 'signal', 'connected'] as const) {
      expect(authorize(ringing, stranger, command)).toBe('not_found');
      expect(authorize(accepted, stranger, command)).toBe('not_found');
      expect(authorize(ended, stranger, command)).toBe('not_found');
    }
  });

  it('hides a call from a callee who had blocked the caller', () => {
    const hidden = { ...ringing, hiddenFromCallee: true };
    expect(authorize(hidden, callee, 'accept')).toBe('not_found');
    expect(authorize(hidden, callee, 'decline')).toBe('not_found');
    expect(authorize(hidden, caller, 'cancel')).toBeUndefined();
  });

  it('lets only the callee accept or decline, on any device, while ringing', () => {
    expect(authorize(ringing, callee, 'accept')).toBeUndefined();
    expect(authorize(ringing, calleeTablet, 'accept')).toBeUndefined();
    expect(authorize(ringing, calleeTablet, 'decline')).toBeUndefined();
    // The caller cannot answer their own call (no forged participation).
    expect(authorize(ringing, caller, 'accept')).toBe('not_found');
  });

  it('refuses duplicate acceptance', () => {
    expect(authorize(accepted, callee, 'accept')).toBe('forbidden');
    expect(authorize(accepted, calleeTablet, 'accept')).toBe('answered_elsewhere');
    expect(authorize(accepted, calleeTablet, 'decline')).toBe('answered_elsewhere');
  });

  it('refuses everything once the call has ended (stale and replayed events)', () => {
    for (const command of ['accept', 'decline', 'cancel', 'end', 'signal', 'connected'] as const) {
      expect(authorize(ended, caller, command)).toBe('ended');
      expect(authorize(ended, callee, command)).toBe('ended');
    }
  });

  it('only lets the device that started the call cancel it', () => {
    expect(authorize(ringing, caller, 'cancel')).toBeUndefined();
    expect(authorize(ringing, callerLaptop, 'cancel')).toBe('forbidden');
  });

  it('relays signaling only between the two devices in the call, after it is answered', () => {
    expect(authorize(ringing, caller, 'signal', 'offer')).toBe('forbidden');
    expect(authorize(accepted, caller, 'signal', 'offer')).toBeUndefined();
    expect(authorize(accepted, callee, 'signal', 'answer')).toBeUndefined();
    expect(authorize(accepted, callee, 'signal', 'ice')).toBeUndefined();
    expect(authorize(accepted, caller, 'signal', 'media')).toBeUndefined();
    expect(authorize(accepted, callerLaptop, 'signal', 'ice')).toBe('forbidden');
    expect(authorize(accepted, calleeTablet, 'signal', 'ice')).toBe('forbidden');
  });

  it('fixes the offer direction (caller offers, callee answers) so offers never collide', () => {
    expect(authorize(accepted, callee, 'signal', 'offer')).toBe('forbidden');
    expect(authorize(accepted, caller, 'signal', 'answer')).toBe('forbidden');
  });

  it('accepts hang-ups only from the two devices in an answered call', () => {
    expect(authorize(accepted, caller, 'end')).toBeUndefined();
    expect(authorize(accepted, callee, 'end')).toBeUndefined();
    expect(authorize(accepted, callerLaptop, 'end')).toBe('forbidden');
    expect(authorize(accepted, calleeTablet, 'end')).toBe('answered_elsewhere');
  });
});

describe('call outcomes', () => {
  it('maps hang-ups to outcomes by state', () => {
    expect(hangUp(ringing, caller)).toEqual({ outcome: 'CANCELLED', reason: 'cancelled' });
    expect(hangUp(ringing, callee)).toEqual({ outcome: 'DECLINED', reason: 'declined' });
    expect(hangUp(accepted, caller)).toEqual({ outcome: 'CANCELLED', reason: 'cancelled' });
    expect(hangUp(accepted, callee, true)).toEqual({ outcome: 'FAILED', reason: 'failed' });
    expect(hangUp(connected, callee)).toEqual({ outcome: 'COMPLETED', reason: 'hangup' });
    expect(hangUp(connected, caller, true)).toEqual({ outcome: 'COMPLETED', reason: 'failed' });
  });

  const timing = {
    now: 0,
    createdAt: 0,
    answeredAt: null,
    ringTimeoutMs: 45_000,
    connectTimeoutMs: 30_000,
    maxDurationMs: 4 * 60 * 60_000,
  };

  it('times out unanswered calls as missed', () => {
    expect(timedOut(ringing, { ...timing, now: 44_999 })).toBeUndefined();
    expect(timedOut(ringing, { ...timing, now: 45_000 })).toEqual({
      outcome: 'MISSED',
      reason: 'timeout',
    });
  });

  it('fails answered calls whose media never connects', () => {
    const t = { ...timing, answeredAt: 10_000 };
    expect(timedOut(accepted, { ...t, now: 39_999 })).toBeUndefined();
    expect(timedOut(accepted, { ...t, now: 40_000 })).toEqual({
      outcome: 'FAILED',
      reason: 'failed',
    });
    // A connected call does not time out on connection.
    expect(timedOut(connected, { ...t, now: 60_000 })).toBeUndefined();
  });

  it('ends calls left open far too long', () => {
    expect(timedOut(connected, { ...timing, answeredAt: 0, now: timing.maxDurationMs })).toEqual({
      outcome: 'COMPLETED',
      reason: 'timeout',
    });
  });

  it('depends on the caller device while ringing, then on both devices', () => {
    expect(requiredDevices(ringing)).toEqual(['caller-phone']);
    expect(requiredDevices(accepted)).toEqual(['caller-phone', 'callee-phone']);
    expect(requiredDevices(ended)).toEqual([]);
    expect(deviceLost(ringing).outcome).toBe('CANCELLED');
    expect(deviceLost(accepted).outcome).toBe('FAILED');
    expect(deviceLost(connected)).toEqual({ outcome: 'COMPLETED', reason: 'disconnected' });
  });

  it('reports a block during a call as an ordinary hang-up', () => {
    expect(blockedDuringCall(connected, 'callee')).toEqual({
      outcome: 'COMPLETED',
      reason: 'hangup',
    });
    expect(blockedDuringCall(ringing, 'callee')).toEqual({
      outcome: 'DECLINED',
      reason: 'declined',
    });
    expect(blockedDuringCall(ringing, 'caller').reason).toBe('cancelled');
  });

  it('measures duration only from connection', () => {
    expect(durationSeconds(null, new Date(5_000))).toBeNull();
    expect(durationSeconds(new Date(1_000), new Date(62_400))).toBe(61);
  });
});
