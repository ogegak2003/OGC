import type { ProfileSummary } from './social.js';

/**
 * One-to-one voice and video calls (Phase 6). Signaling runs over the authenticated realtime
 * connection; media flows directly between the two devices with WebRTC (DTLS-SRTP), or through
 * a TURN relay when one is configured and needed. See docs/architecture/calls.md.
 */

export const CALL_MEDIA = ['AUDIO', 'VIDEO'] as const;
export type CallMedia = (typeof CALL_MEDIA)[number];

/**
 * `RINGING` until the callee answers on one device, `ACCEPTED` while the two devices connect
 * and talk (`connectedAt` is set once media flows), then `ENDED` with an outcome.
 */
export type CallStatus = 'RINGING' | 'ACCEPTED' | 'ENDED';

/**
 * - `COMPLETED`: media connected and the call was hung up (or dropped) afterwards.
 * - `MISSED`: nobody answered before the ring timeout.
 * - `DECLINED`: the callee declined.
 * - `CANCELLED`: the caller hung up before an answer.
 * - `BUSY`: the callee was already in a call.
 * - `FAILED`: answered, but media never connected (network, permissions, device lost).
 */
export type CallOutcome = 'COMPLETED' | 'MISSED' | 'DECLINED' | 'CANCELLED' | 'BUSY' | 'FAILED';

/** A call as one of its participants sees it. */
export interface CallView {
  id: string;
  conversationId: string;
  media: CallMedia;
  /** Relative to the viewer. */
  direction: 'OUTGOING' | 'INCOMING';
  /** The other participant (photo only where the viewer may see it). */
  peer: ProfileSummary;
  status: CallStatus;
  outcome: CallOutcome | null;
  createdAt: string;
  answeredAt: string | null;
  /** When media first connected; the duration is measured from here. */
  connectedAt: string | null;
  endedAt: string | null;
  /** Whole seconds between `connectedAt` and `endedAt`; null if media never connected. */
  durationSeconds: number | null;
}

/** `GET /v1/calls` — the viewer's call history, newest first. */
export interface CallPage {
  items: CallView[];
  nextCursor: string | null;
}

/** An `RTCIceServer` (STUN, or TURN with short-lived credentials issued for one call). */
export interface IceServerView {
  urls: string[];
  username?: string;
  credential?: string;
}

/** What a device needs to set up media for a call it started or answered. */
export interface CallSetup {
  call: CallView;
  iceServers: IceServerView[];
  /** `relay` forces media through TURN, so neither device learns the other's IP address. */
  iceTransportPolicy: 'all' | 'relay';
}

/**
 * Signaling relayed between the two devices in a call. Session descriptions and candidates
 * are opaque to the server (size-limited, never logged). `media` tells the peer that the
 * microphone or camera was turned off, so it can show that instead of silence or a black frame.
 */
export type CallSignal =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | {
      type: 'ice';
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { type: 'media'; microphone: boolean; camera: boolean };

/**
 * Why a call ended, as sent to the participants' devices. A block during a call is reported
 * as `hangup`, so it is not revealed to the blocked person.
 */
export type CallEndReason =
  'hangup' | 'cancelled' | 'declined' | 'timeout' | 'busy' | 'failed' | 'disconnected';

/** Errors returned in call acknowledgements. */
export type CallErrorCode =
  | 'invalid'
  | 'rate_limited'
  /** No such call/conversation for this account (also: not a participant). */
  | 'not_found'
  /** Calls are not possible in this conversation (group, blocked by you, inactive account). */
  | 'unavailable'
  /** You are already in a call. */
  | 'in_call'
  /** The call is over (or was answered on another device). */
  | 'ended'
  | 'answered_elsewhere'
  /** This device is not the one taking part in the call, or the event is not allowed now. */
  | 'forbidden';
