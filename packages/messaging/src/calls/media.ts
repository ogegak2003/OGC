import type { IceServerView } from '@ogc/types';

/**
 * The small part of the WebRTC API the call engine uses, described structurally so both the
 * browser implementation and `react-native-webrtc` (which follows the W3C API) satisfy it.
 */

export interface MediaTrackLike {
  readonly kind: string;
  enabled: boolean;
  stop(): void;
}

export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
  getAudioTracks(): MediaTrackLike[];
  getVideoTracks(): MediaTrackLike[];
}

export interface SessionDescriptionLike {
  type: string;
  sdp?: string | undefined;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface RtpSenderLike {
  readonly track: MediaTrackLike | null;
  replaceTrack(track: MediaTrackLike | null): Promise<void>;
}

/** Events the engine listens to: `icecandidate`, `track`, `iceconnectionstatechange`. */
export interface PeerConnectionLike {
  readonly iceConnectionState: string;
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown;
  getSenders(): RtpSenderLike[];
  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  close(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type CameraFacing = 'user' | 'environment';

export interface MediaRequest {
  audio: true;
  /** `false` for voice calls: the camera is never requested for them. */
  video: false | { facingMode: CameraFacing };
}

/**
 * Platform media access: `getUserMedia`, peer connections, and optional extras. Errors from
 * `getUserMedia` should keep the standard names (`NotAllowedError`, `NotFoundError`, …).
 */
export interface CallMediaPlatform {
  getUserMedia(request: MediaRequest): Promise<MediaStreamLike>;
  createPeerConnection(config: {
    iceServers: IceServerView[];
    iceTransportPolicy: 'all' | 'relay';
  }): PeerConnectionLike;
  /**
   * Switches between front and rear cameras for the local stream (and what is sent), resolving
   * with the new facing mode, or `undefined` when only one camera exists.
   */
  switchCamera?(
    stream: MediaStreamLike,
    peer: PeerConnectionLike | null,
    current: CameraFacing,
  ): Promise<CameraFacing | undefined>;
  /** Whether more than one camera is available (shows the switch-camera control). */
  canSwitchCamera?(): Promise<boolean>;
  /** Native audio session (earpiece/speaker routing). Called when a call starts and ends. */
  audio?: {
    start(media: 'AUDIO' | 'VIDEO'): void;
    setSpeaker(on: boolean): void;
    stop(): void;
  };
}
