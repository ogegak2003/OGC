import type { CallEndReason, CallErrorCode, CallOutcome, CallSignal } from '@ogc/types';

/**
 * Call state machine (ADR-037), kept free of I/O so every rule is unit-tested. The service
 * applies a decision with a conditional UPDATE on the expected state, so concurrent events
 * (two devices accepting, a hang-up racing a timeout) resolve to exactly one winner.
 *
 *   RINGING ──accept──▶ ACCEPTED ──end──▶ ENDED (COMPLETED | CANCELLED | FAILED)
 *      │                    └─connect timeout / device lost──▶ ENDED (FAILED | COMPLETED)
 *      └─decline / cancel / ring timeout / caller lost──▶ ENDED (DECLINED | CANCELLED | MISSED)
 *   (start while the callee is in a call ──▶ ENDED (BUSY) immediately)
 */

export interface CallSnapshot {
  status: 'RINGING' | 'ACCEPTED' | 'ENDED';
  callerId: string;
  calleeId: string;
  callerDeviceId: string | null;
  calleeDeviceId: string | null;
  hiddenFromCallee: boolean;
  connectedAt: Date | null;
}

/** The authenticated sender of an event (from the socket session, never the payload). */
export interface Actor {
  userId: string;
  deviceId: string;
}

export type CallCommand = 'accept' | 'decline' | 'cancel' | 'end' | 'signal' | 'connected';

/**
 * Whether `actor` may send `command` for this call now. Non-participants — and a callee who
 * never saw the call because they had blocked the caller — get `not_found`, exactly as for a
 * call that does not exist, so call IDs cannot be probed.
 */
export function authorize(
  call: CallSnapshot,
  actor: Actor,
  command: CallCommand,
  signal?: CallSignal['type'],
): CallErrorCode | undefined {
  const isCaller = actor.userId === call.callerId;
  const isCallee = actor.userId === call.calleeId && !call.hiddenFromCallee;
  if (!isCaller && !isCallee) return 'not_found';
  if (call.status === 'ENDED') return 'ended';
  const onCallerDevice = isCaller && actor.deviceId === call.callerDeviceId;
  const onCalleeDevice = isCallee && actor.deviceId === call.calleeDeviceId;

  switch (command) {
    case 'accept':
    case 'decline':
      if (!isCallee) return 'not_found';
      if (call.status === 'RINGING') return undefined;
      return onCalleeDevice ? 'forbidden' : 'answered_elsewhere';
    case 'cancel':
    case 'end':
      // Ringing: the caller's device cancels; any of the callee's devices declines.
      if (call.status === 'RINGING') return onCallerDevice || isCallee ? undefined : 'forbidden';
      if (onCallerDevice || onCalleeDevice) return undefined;
      return isCallee ? 'answered_elsewhere' : 'forbidden';
    case 'signal':
    case 'connected':
      if (call.status !== 'ACCEPTED' || !(onCallerDevice || onCalleeDevice)) return 'forbidden';
      // Only the caller offers (initial offer and ICE restarts); only the callee answers. One
      // fixed direction means no offer collisions ("glare") to resolve.
      if (signal === 'offer' && !onCallerDevice) return 'forbidden';
      if (signal === 'answer' && !onCalleeDevice) return 'forbidden';
      return undefined;
  }
}

export interface Ending {
  outcome: CallOutcome;
  reason: CallEndReason;
}

/** How a participant's hang-up (or a reported media failure) ends the call. */
export function hangUp(call: CallSnapshot, actor: Actor, failed = false): Ending {
  if (call.status === 'RINGING') {
    return actor.userId === call.callerId
      ? { outcome: 'CANCELLED', reason: 'cancelled' }
      : { outcome: 'DECLINED', reason: 'declined' };
  }
  if (call.connectedAt) return { outcome: 'COMPLETED', reason: failed ? 'failed' : 'hangup' };
  return failed
    ? { outcome: 'FAILED', reason: 'failed' }
    : { outcome: 'CANCELLED', reason: 'cancelled' };
}

export interface Timing {
  now: number;
  createdAt: number;
  answeredAt: number | null;
  ringTimeoutMs: number;
  connectTimeoutMs: number;
  maxDurationMs: number;
}

/** Server-side timeouts: unanswered, never connected, or open far too long. */
export function timedOut(call: CallSnapshot, t: Timing): Ending | undefined {
  if (call.status === 'RINGING' && t.now - t.createdAt >= t.ringTimeoutMs) {
    return { outcome: 'MISSED', reason: 'timeout' };
  }
  if (
    call.status === 'ACCEPTED' &&
    !call.connectedAt &&
    t.answeredAt !== null &&
    t.now - t.answeredAt >= t.connectTimeoutMs
  ) {
    return { outcome: 'FAILED', reason: 'failed' };
  }
  if (call.status !== 'ENDED' && t.now - t.createdAt >= t.maxDurationMs) {
    return call.connectedAt
      ? { outcome: 'COMPLETED', reason: 'timeout' }
      : { outcome: 'FAILED', reason: 'timeout' };
  }
  return undefined;
}

/** The devices whose realtime connection the call depends on right now. */
export function requiredDevices(call: CallSnapshot): string[] {
  if (call.status === 'RINGING') return call.callerDeviceId ? [call.callerDeviceId] : [];
  if (call.status === 'ACCEPTED') {
    return [call.callerDeviceId, call.calleeDeviceId].filter((d): d is string => d !== null);
  }
  return [];
}

/** A required device stayed offline past the reconnection grace period. */
export function deviceLost(call: CallSnapshot): Ending {
  if (call.status === 'RINGING') return { outcome: 'CANCELLED', reason: 'disconnected' };
  return call.connectedAt
    ? { outcome: 'COMPLETED', reason: 'disconnected' }
    : { outcome: 'FAILED', reason: 'disconnected' };
}

/**
 * One participant blocked the other during the call. Reported to both as an ordinary hang-up
 * by the blocker, so the blocked person cannot tell a block from a hang-up.
 */
export function blockedDuringCall(call: CallSnapshot, blockerId: string): Ending {
  if (call.status === 'RINGING') {
    return blockerId === call.callerId
      ? { outcome: 'CANCELLED', reason: 'cancelled' }
      : { outcome: 'DECLINED', reason: 'declined' };
  }
  return call.connectedAt
    ? { outcome: 'COMPLETED', reason: 'hangup' }
    : { outcome: 'CANCELLED', reason: 'cancelled' };
}

/** Whole seconds of connected media, or null when media never connected. */
export function durationSeconds(connectedAt: Date | null, endedAt: Date | null): number | null {
  if (!connectedAt || !endedAt) return null;
  return Math.max(0, Math.round((endedAt.getTime() - connectedAt.getTime()) / 1000));
}
