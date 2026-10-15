import type {
  CallEndReason,
  CallMedia,
  CallOutcome,
  CallSetup,
  CallSignal,
  CallView,
  ClientToServerEvents,
  ProfileSummary,
  ServerToClientEvents,
} from '@ogc/types';
import type {
  CallMediaPlatform,
  CameraFacing,
  IceCandidateLike,
  MediaStreamLike,
  PeerConnectionLike,
} from './media.js';

/**
 * Call signaling requests, answered by the server's acknowledgement (or `offline` /
 * `timeout` when the realtime connection cannot deliver them).
 */
export type CallRequestName = Extract<keyof ClientToServerEvents, `call.${string}`>;
export type CallAck<E extends CallRequestName> = Parameters<
  Parameters<ClientToServerEvents[E]>[1]
>[0];

export interface CallSignaling {
  callRequest<E extends CallRequestName>(
    event: E,
    payload: Parameters<ClientToServerEvents[E]>[0],
  ): Promise<CallAck<E>>;
}

export type CallPhase =
  /** No call. */
  | 'idle'
  /** Calling: waiting for the other person to answer. */
  | 'outgoing'
  /** Someone is calling this account. */
  | 'incoming'
  /** Answered; media is being set up (or re-established). */
  | 'connecting'
  /** Media is flowing. */
  | 'active'
  /** Finished; `ending` says how. Dismissed by the UI (or the next call). */
  | 'ended';

/** Why a call could not start or continue on this device (beyond the server's reasons). */
export type CallFailure =
  | 'permission_denied'
  | 'no_device'
  | 'unsupported'
  | 'offline'
  | 'unavailable'
  | 'in_call'
  | 'rate_limited'
  | 'answered_elsewhere'
  | 'error';

export interface CallState {
  phase: CallPhase;
  /** The call as the server described it; null until the server has confirmed it. */
  call: CallView | null;
  /** Who is being called / calling (known before the server confirms an outgoing call). */
  peer: ProfileSummary | null;
  media: CallMedia | null;
  direction: 'OUTGOING' | 'INCOMING' | null;
  localStream: MediaStreamLike | null;
  remoteStream: MediaStreamLike | null;
  microphoneMuted: boolean;
  cameraOff: boolean;
  remoteMicrophoneMuted: boolean;
  remoteCameraOff: boolean;
  facing: CameraFacing;
  canSwitchCamera: boolean;
  /** Speakerphone (mobile only; video calls default to the speaker). */
  speakerOn: boolean;
  /** Media dropped and the engine is trying to recover (ICE restart). */
  reconnecting: boolean;
  /** Local clock time when media first connected (for the duration display). */
  connectedAt: number | null;
  /** Set when `phase` is `ended`. */
  ending: { outcome: CallOutcome | null; reason: CallEndReason | CallFailure } | null;
  /** This device can make and receive calls (false e.g. in Expo Go, which has no WebRTC). */
  supported: boolean;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** After media drops, the caller restarts ICE if it has not recovered within this time. */
export const ICE_RESTART_DELAY_MS = 4_000;
/** A dropped call that has not recovered within this time is ended as failed. */
export const MEDIA_RECOVERY_TIMEOUT_MS = 20_000;

/** No call (what the UI shows before calls are available). */
export const IDLE_CALL_STATE: Readonly<CallState> = {
  phase: 'idle',
  call: null,
  peer: null,
  media: null,
  direction: null,
  localStream: null,
  remoteStream: null,
  microphoneMuted: false,
  cameraOff: false,
  remoteMicrophoneMuted: false,
  remoteCameraOff: false,
  facing: 'user',
  canSwitchCamera: false,
  speakerOn: false,
  reconnecting: false,
  connectedAt: null,
  ending: null,
  supported: true,
};

function mediaFailure(error: unknown): CallFailure {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'permission_denied';
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  ) {
    return 'no_device';
  }
  return 'error';
}

function failureFrom(code: string): CallFailure {
  switch (code) {
    case 'offline':
    case 'timeout':
      return 'offline';
    case 'in_call':
    case 'rate_limited':
    case 'answered_elsewhere':
      return code;
    case 'unavailable':
    case 'not_found':
      return 'unavailable';
    default:
      return 'error';
  }
}

/**
 * One-to-one calls on this device: signaling over the realtime connection and media over
 * WebRTC, shared by the web and mobile apps. The engine never pretends: the duration starts
 * when ICE actually connects, and every failure (permissions, network, the other side) ends
 * the call with a reason the UI can show.
 *
 * Offers always come from the caller (initial and ICE restarts) and answers from the callee,
 * matching the server's rule, so the two sides never offer at the same time.
 */
export class CallEngine {
  private state: CallState;
  private readonly listeners = new Set<(state: CallState) => void>();
  private peer: PeerConnectionLike | null = null;
  private setup: CallSetup | null = null;
  private pendingCandidates: IceCandidateLike[] = [];
  private remoteDescriptionSet = false;
  private restartTimer: unknown;
  private recoveryTimer: unknown;
  /** Bumped on teardown, so async work from a previous call cannot touch the next one. */
  private generation = 0;

  constructor(
    private readonly signaling: CallSignaling,
    private readonly platform: CallMediaPlatform | undefined,
    private readonly clock: Clock = systemClock,
  ) {
    this.state = { ...IDLE_CALL_STATE, supported: platform !== undefined };
  }

  get current(): CallState {
    return this.state;
  }

  subscribe(listener: (state: CallState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private get busy(): boolean {
    return this.state.phase !== 'idle' && this.state.phase !== 'ended';
  }

  private get callId(): string | undefined {
    return this.state.call?.id;
  }

  // ── Actions (from the UI) ─────────────────────────────────────────────────────────────────

  /** Calls the other participant of a direct conversation. */
  async start(conversationId: string, media: CallMedia, peer: ProfileSummary): Promise<void> {
    if (this.busy) return;
    const generation = ++this.generation;
    this.set({
      ...IDLE_CALL_STATE,
      supported: this.platform !== undefined,
      phase: 'outgoing',
      peer,
      media,
      direction: 'OUTGOING',
      speakerOn: media === 'VIDEO',
    });
    if (!this.platform) {
      this.finish(null, 'unsupported');
      return;
    }
    // Ask for the microphone (and camera, for video only) before ringing anyone.
    const stream = await this.openMedia(media);
    if (generation !== this.generation) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      return;
    }
    if (!stream) return;
    const ack = await this.signaling.callRequest('call.start', { conversationId, media });
    if (generation !== this.generation) return;
    if (!ack.ok) {
      this.finish(null, failureFrom(ack.error));
      return;
    }
    this.setup = ack.data;
    this.set({ call: ack.data.call, peer: ack.data.call.peer });
    if (ack.data.call.status === 'ENDED') {
      this.finish(ack.data.call.outcome, ack.data.call.outcome === 'BUSY' ? 'busy' : 'failed');
    }
  }

  /** Answers the ringing call on this device. */
  async accept(): Promise<void> {
    const call = this.state.call;
    if (this.state.phase !== 'incoming' || !call) return;
    const generation = this.generation;
    if (!this.platform) {
      this.finish(null, 'unsupported');
      return;
    }
    this.set({ phase: 'connecting' });
    const stream = await this.openMedia(call.media);
    if (!stream) {
      // Without a microphone (or camera) this device cannot take the call: tell the caller now.
      void this.signaling.callRequest('call.decline', { callId: call.id });
      return;
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const ack = await this.signaling.callRequest('call.accept', { callId: call.id });
    if (generation !== this.generation) return;
    if (!ack.ok) {
      this.finish(null, ack.error === 'ended' ? 'unavailable' : failureFrom(ack.error));
      return;
    }
    this.setup = ack.data;
    this.set({ call: ack.data.call });
    this.createPeer();
  }

  async decline(): Promise<void> {
    const call = this.state.call;
    if (this.state.phase !== 'incoming' || !call) return;
    this.teardown();
    this.set({ ...IDLE_CALL_STATE, supported: this.state.supported });
    await this.signaling.callRequest('call.decline', { callId: call.id });
  }

  /** Cancels an outgoing call or hangs up an answered one. */
  async hangUp(): Promise<void> {
    const call = this.state.call;
    const phase = this.state.phase;
    if (phase === 'incoming') {
      await this.decline();
      return;
    }
    if (!this.busy) return;
    this.finish(null, phase === 'outgoing' ? 'cancelled' : 'hangup');
    if (call) {
      await this.signaling.callRequest(phase === 'outgoing' ? 'call.cancel' : 'call.end', {
        callId: call.id,
      });
    }
  }

  /** Closes the "call ended" screen. */
  dismiss(): void {
    if (this.state.phase === 'ended')
      this.set({ ...IDLE_CALL_STATE, supported: this.state.supported });
  }

  toggleMicrophone(): void {
    const muted = !this.state.microphoneMuted;
    for (const track of this.state.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.set({ microphoneMuted: muted });
    this.sendMediaState();
  }

  toggleCamera(): void {
    if (this.state.media !== 'VIDEO') return;
    const off = !this.state.cameraOff;
    for (const track of this.state.localStream?.getVideoTracks() ?? []) track.enabled = !off;
    this.set({ cameraOff: off });
    this.sendMediaState();
  }

  async switchCamera(): Promise<void> {
    const stream = this.state.localStream;
    if (this.state.media !== 'VIDEO' || !stream || !this.platform?.switchCamera) return;
    const facing = await this.platform.switchCamera(stream, this.peer, this.state.facing);
    if (facing) this.set({ facing });
  }

  toggleSpeaker(): void {
    if (!this.platform?.audio) return;
    const on = !this.state.speakerOn;
    this.platform.audio.setSpeaker(on);
    this.set({ speakerOn: on });
  }

  // ── Server events ─────────────────────────────────────────────────────────────────────────

  handleEvent<E extends keyof ServerToClientEvents>(
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ): void {
    switch (event) {
      case 'call.incoming': {
        const { call } = payload as Parameters<ServerToClientEvents['call.incoming']>[0];
        // Already in a call here (the server marks busy calls before ringing; this is a guard).
        if (this.busy) return;
        this.generation++;
        this.set({
          ...IDLE_CALL_STATE,
          supported: this.platform !== undefined,
          phase: 'incoming',
          call,
          peer: call.peer,
          media: call.media,
          direction: 'INCOMING',
          speakerOn: call.media === 'VIDEO',
        });
        return;
      }
      case 'call.accepted': {
        const { callId } = payload as Parameters<ServerToClientEvents['call.accepted']>[0];
        if (callId !== this.callId || this.state.phase !== 'outgoing') return;
        this.set({ phase: 'connecting' });
        this.createPeer();
        void this.offer(false);
        return;
      }
      case 'call.answered_elsewhere': {
        const { callId } = payload as Parameters<
          ServerToClientEvents['call.answered_elsewhere']
        >[0];
        if (callId !== this.callId || this.state.phase !== 'incoming') return;
        this.finish(null, 'answered_elsewhere');
        return;
      }
      case 'call.signal': {
        const { callId, signal } = payload as Parameters<ServerToClientEvents['call.signal']>[0];
        if (callId !== this.callId || !this.peer) return;
        void this.onSignal(signal);
        return;
      }
      case 'call.ended': {
        const { call, reason } = payload as Parameters<ServerToClientEvents['call.ended']>[0];
        if (call.id !== this.callId) return;
        if (this.state.phase === 'ended') {
          // We hung up first; keep the screen, but show the server's final record.
          this.set({
            call,
            ending: { outcome: call.outcome, reason: this.state.ending?.reason ?? reason },
          });
          return;
        }
        this.set({ call });
        this.finish(call.outcome, reason);
        return;
      }
      default:
        return;
    }
  }

  /**
   * After the realtime connection comes back (or the app returns to the foreground): make
   * sure the call shown here still exists, or show a call that started ringing meanwhile.
   */
  async resync(): Promise<void> {
    const ack = await this.signaling.callRequest('call.sync', {});
    if (!ack.ok) return;
    const open = ack.data;
    const current = this.state.call;
    if (this.busy && current) {
      if (open?.call.id !== current.id) {
        // The call ended while we were away.
        this.finish(null, 'disconnected');
        return;
      }
      if (open.call.status === 'ACCEPTED' && !open.onThisDevice) {
        this.finish(null, 'answered_elsewhere');
      }
      return;
    }
    if (!open || this.busy) return;
    if (open.call.direction === 'INCOMING' && open.call.status === 'RINGING') {
      this.handleEvent('call.incoming', { call: open.call });
    } else if (open.onThisDevice) {
      // This device was in a call but its media session is gone (e.g. the page reloaded).
      await this.signaling.callRequest('call.end', { callId: open.call.id });
    }
  }

  /** Releases the camera, microphone and connection (sign-out, unmount). */
  dispose(): void {
    const call = this.state.call;
    if (call && this.busy) {
      void this.signaling.callRequest(
        this.state.phase === 'incoming'
          ? 'call.decline'
          : this.state.phase === 'outgoing'
            ? 'call.cancel'
            : 'call.end',
        { callId: call.id },
      );
    }
    this.teardown();
    this.listeners.clear();
  }

  // ── Media ─────────────────────────────────────────────────────────────────────────────────

  private async openMedia(media: CallMedia): Promise<MediaStreamLike | null> {
    if (!this.platform) return null;
    try {
      const stream = await this.platform.getUserMedia({
        audio: true,
        video: media === 'VIDEO' ? { facingMode: 'user' } : false,
      });
      const canSwitch =
        media === 'VIDEO' && this.platform.canSwitchCamera
          ? await this.platform.canSwitchCamera().catch(() => false)
          : false;
      this.set({ localStream: stream, canSwitchCamera: canSwitch });
      this.platform.audio?.start(media);
      this.platform.audio?.setSpeaker(media === 'VIDEO');
      return stream;
    } catch (error) {
      this.finish(null, mediaFailure(error));
      return null;
    }
  }

  private createPeer(): void {
    const stream = this.state.localStream;
    if (!this.platform || !this.setup || !stream) return;
    const generation = this.generation;
    const peer = this.platform.createPeerConnection({
      iceServers: this.setup.iceServers,
      iceTransportPolicy: this.setup.iceTransportPolicy,
    });
    this.peer = peer;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    for (const track of stream.getTracks()) peer.addTrack(track, stream);

    peer.addEventListener('icecandidate', (event: { candidate: IceCandidateLike | null }) => {
      const callId = this.callId;
      if (generation !== this.generation || !callId || !event.candidate) return;
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      void this.signaling.callRequest('call.signal', {
        callId,
        signal: {
          type: 'ice',
          candidate,
          sdpMid: sdpMid ?? null,
          sdpMLineIndex: sdpMLineIndex ?? null,
        },
      });
    });

    peer.addEventListener('track', (event: { streams?: MediaStreamLike[] }) => {
      if (generation !== this.generation) return;
      const remote = event.streams?.[0];
      if (remote) this.set({ remoteStream: remote });
    });

    peer.addEventListener('iceconnectionstatechange', () => {
      if (generation !== this.generation) return;
      this.onIceState(peer.iceConnectionState);
    });
  }

  private onIceState(state: string): void {
    if (state === 'connected' || state === 'completed') {
      this.clearRecovery();
      const first = this.state.connectedAt === null;
      this.set({
        phase: 'active',
        reconnecting: false,
        connectedAt: this.state.connectedAt ?? this.clock.now(),
      });
      const callId = this.callId;
      if (first && callId) {
        void this.signaling.callRequest('call.connected', { callId });
        this.sendMediaState();
      }
      return;
    }
    if (state === 'disconnected' || state === 'failed') {
      if (this.state.phase !== 'active' && this.state.phase !== 'connecting') return;
      this.set({ reconnecting: this.state.connectedAt !== null });
      // The caller drives recovery with an ICE restart; the callee answers it.
      if (this.state.direction === 'OUTGOING' && this.restartTimer === undefined) {
        this.restartTimer = this.clock.setTimeout(
          () => {
            this.restartTimer = undefined;
            void this.offer(true);
          },
          state === 'failed' ? 0 : ICE_RESTART_DELAY_MS,
        );
      }
      if (this.recoveryTimer === undefined) {
        this.recoveryTimer = this.clock.setTimeout(() => {
          this.recoveryTimer = undefined;
          void this.failMedia();
        }, MEDIA_RECOVERY_TIMEOUT_MS);
      }
    }
  }

  private clearRecovery(): void {
    if (this.restartTimer !== undefined) this.clock.clearTimeout(this.restartTimer);
    if (this.recoveryTimer !== undefined) this.clock.clearTimeout(this.recoveryTimer);
    this.restartTimer = undefined;
    this.recoveryTimer = undefined;
  }

  private async failMedia(): Promise<void> {
    const call = this.state.call;
    if (!call || !this.busy) return;
    this.finish(null, 'failed');
    await this.signaling.callRequest('call.end', { callId: call.id, reason: 'failed' });
  }

  private async offer(iceRestart: boolean): Promise<void> {
    const peer = this.peer;
    const callId = this.callId;
    if (!peer || !callId) return;
    try {
      const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.setLocalDescription(offer);
      if (peer !== this.peer) return;
      await this.signaling.callRequest('call.signal', {
        callId,
        signal: { type: 'offer', sdp: offer.sdp ?? '' },
      });
    } catch {
      if (peer === this.peer) await this.failMedia();
    }
  }

  private async onSignal(signal: CallSignal): Promise<void> {
    const peer = this.peer;
    const callId = this.callId;
    if (!peer || !callId) return;
    try {
      switch (signal.type) {
        case 'offer': {
          if (this.state.direction !== 'INCOMING') return;
          await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          await this.remoteDescriptionReady(peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          if (peer !== this.peer) return;
          await this.signaling.callRequest('call.signal', {
            callId,
            signal: { type: 'answer', sdp: answer.sdp ?? '' },
          });
          return;
        }
        case 'answer':
          if (this.state.direction !== 'OUTGOING') return;
          await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await this.remoteDescriptionReady(peer);
          return;
        case 'ice': {
          const candidate = {
            candidate: signal.candidate,
            sdpMid: signal.sdpMid,
            sdpMLineIndex: signal.sdpMLineIndex,
          };
          if (this.remoteDescriptionSet) await peer.addIceCandidate(candidate);
          else this.pendingCandidates.push(candidate);
          return;
        }
        case 'media':
          this.set({ remoteMicrophoneMuted: !signal.microphone, remoteCameraOff: !signal.camera });
          return;
      }
    } catch {
      // A description that cannot be applied means this call cannot carry media.
      if (peer === this.peer && signal.type !== 'ice') await this.failMedia();
    }
  }

  private async remoteDescriptionReady(peer: PeerConnectionLike): Promise<void> {
    this.remoteDescriptionSet = true;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) await peer.addIceCandidate(candidate).catch(() => undefined);
  }

  private sendMediaState(): void {
    const callId = this.callId;
    if (!callId || !this.peer) return;
    void this.signaling.callRequest('call.signal', {
      callId,
      signal: {
        type: 'media',
        microphone: !this.state.microphoneMuted,
        camera: this.state.media === 'VIDEO' && !this.state.cameraOff,
      },
    });
  }

  private finish(outcome: CallOutcome | null, reason: CallEndReason | CallFailure): void {
    this.teardown();
    this.set({
      phase: 'ended',
      ending: { outcome, reason },
      reconnecting: false,
      localStream: null,
      remoteStream: null,
    });
  }

  private teardown(): void {
    this.generation++;
    this.clearRecovery();
    this.peer?.close();
    this.peer = null;
    this.setup = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    for (const track of this.state.localStream?.getTracks() ?? []) track.stop();
    this.platform?.audio?.stop();
  }
}
