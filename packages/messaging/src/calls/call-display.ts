import type { CallMedia, CallView } from '@ogc/types';
import type { CallState } from './call-engine.js';

/** `m:ss`, or `h:mm:ss` from an hour. */
export function callDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}

/**
 * A call-history line for the conversation timeline, from the viewer's side:
 * "Outgoing voice call · 2:31", "Missed video call", "Declined voice call"…
 */
export function callDescription(
  call: Pick<CallView, 'media' | 'direction' | 'outcome' | 'durationSeconds' | 'status'>,
): string {
  const kind = call.media === 'VIDEO' ? 'video call' : 'voice call';
  const incoming = call.direction === 'INCOMING';
  switch (call.status === 'ENDED' ? call.outcome : null) {
    case 'COMPLETED':
      return `${incoming ? 'Incoming' : 'Outgoing'} ${kind}${
        call.durationSeconds !== null ? ` · ${callDuration(call.durationSeconds)}` : ''
      }`;
    case 'MISSED':
      return incoming ? `Missed ${kind}` : `${capitalize(kind)} · No answer`;
    case 'DECLINED':
      return incoming ? `Declined ${kind}` : `${capitalize(kind)} · Declined`;
    case 'CANCELLED':
      return incoming ? `Missed ${kind}` : `Cancelled ${kind}`;
    case 'BUSY':
      return incoming ? `Missed ${kind} (you were on another call)` : `${capitalize(kind)} · Busy`;
    case 'FAILED':
      return `${capitalize(kind)} · Couldn’t connect`;
    default:
      return `${capitalize(kind)} in progress`;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What the call screen says while a call is set up or in progress. Outgoing calls say
 * "Calling…", not "Ringing": the server cannot know whether the other phone actually rings.
 */
export function callStatusText(state: CallState, now: number): string {
  const kind = state.media === 'VIDEO' ? 'video call' : 'voice call';
  switch (state.phase) {
    case 'incoming':
      return state.supported
        ? `Incoming ${kind}`
        : `Incoming ${kind} · not available on this device`;
    case 'outgoing':
      return state.call ? 'Calling…' : 'Starting call…';
    case 'connecting':
      return state.reconnecting ? 'Reconnecting…' : 'Connecting…';
    case 'active':
      return state.reconnecting || state.connectedAt === null
        ? 'Reconnecting…'
        : callDuration((now - state.connectedAt) / 1000);
    case 'ended':
      return state.ending
        ? callEndMessage(state.ending, state.media, state.direction)
        : 'Call ended';
    case 'idle':
      return '';
  }
}

/** Why the call ended (or could not start), in plain words. */
export function callEndMessage(
  ending: NonNullable<CallState['ending']>,
  media: CallMedia | null,
  direction: CallState['direction'],
): string {
  const incoming = direction === 'INCOMING';
  switch (ending.reason) {
    case 'permission_denied':
      return media === 'VIDEO'
        ? 'OGC needs your camera and microphone for video calls. Allow access, then try again.'
        : 'OGC needs your microphone for calls. Allow access, then try again.';
    case 'no_device':
      return media === 'VIDEO' ? 'No camera or microphone was found.' : 'No microphone was found.';
    case 'unsupported':
      return 'Calls aren’t available on this device.';
    case 'offline':
      return 'You’re offline. Check your connection and try again.';
    case 'unavailable':
      return 'This call isn’t available any more.';
    case 'in_call':
      return 'You’re already in a call.';
    case 'rate_limited':
      return 'Too many calls just now. Try again in a minute.';
    case 'answered_elsewhere':
      return 'Answered on another device';
    case 'busy':
      return 'Busy · on another call';
    case 'declined':
      return incoming ? 'Call declined' : 'Declined';
    case 'cancelled':
      return incoming ? 'Missed call' : 'Call cancelled';
    case 'timeout':
      return ending.outcome === 'MISSED' ? (incoming ? 'Missed call' : 'No answer') : 'Call ended';
    case 'failed':
      return ending.outcome === 'COMPLETED' ? 'Connection lost' : 'Call couldn’t connect';
    case 'disconnected':
      return 'Connection lost';
    case 'hangup':
      return 'Call ended';
    case 'error':
      return 'Something went wrong with the call.';
  }
}

/** An incoming call nobody answered (shown as missed, like on a phone). */
export function isMissedCall(call: Pick<CallView, 'direction' | 'outcome'>): boolean {
  return (
    call.direction === 'INCOMING' &&
    (call.outcome === 'MISSED' || call.outcome === 'CANCELLED' || call.outcome === 'BUSY')
  );
}
