import { type MediaStreamLike, callStatusText } from '@ogc/messaging';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useEffect, useId, useRef, useState } from 'react';
import { useCall } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useTheme } from '../../theme/theme';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import styles from './calls.module.css';

/** The "call ended" screen closes itself after this long. */
const ENDED_DISMISS_MS = 3500;

/** Attaches a media stream to an `<audio>`/`<video>` element. */
function useStream<T extends HTMLMediaElement>(stream: MediaStreamLike | null) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    try {
      element.srcObject = (stream as unknown as MediaStream | null) ?? null;
    } catch {
      // Not a native MediaStream (test DOMs): nothing to attach.
      return;
    }
    if (!stream) return;
    try {
      // Autoplay can be refused (no user gesture yet); the user can still press play.
      void (element.play() as Promise<void> | undefined)?.catch(() => undefined);
    } catch {
      // Media playback not available (e.g. a test DOM).
    }
  }, [stream]);
  return ref;
}

/** Re-renders every second while `active`, for the call duration. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

function ControlButton({
  label,
  icon,
  onClick,
  pressed,
  tone = 'neutral',
  disabled = false,
  autoFocus = false,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  onClick: () => void;
  pressed?: boolean;
  tone?: 'neutral' | 'danger' | 'accept';
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={styles.control}>
      <button
        type="button"
        className={[
          styles.round,
          tone === 'danger' ? styles.danger : '',
          tone === 'accept' ? styles.accept : '',
          pressed ? styles.pressed : '',
        ].join(' ')}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        autoFocus={autoFocus}
      >
        <Icon name={icon} size={26} />
      </button>
      <span className={styles.controlLabel} aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

/**
 * Full-screen call interface over any signed-in page: incoming call (who and what kind),
 * outgoing ("Calling…"), connecting, the call itself, and how it ended. Nothing here is
 * simulated: the timer starts when media actually connects, and failures say why.
 */
export function CallOverlay() {
  const { calls } = useMessaging();
  const state = useCall();
  const { accent } = useTheme();
  const titleId = useId();
  const statusId = useId();
  const now = useNow(state.phase === 'active');
  const remoteVideo = useStream<HTMLVideoElement>(state.remoteStream);
  const remoteAudio = useStream<HTMLAudioElement>(state.remoteStream);
  const localVideo = useStream<HTMLVideoElement>(state.localStream);

  useEffect(() => {
    if (state.phase !== 'ended' || !calls) return;
    const timer = setTimeout(() => {
      calls.dismiss();
    }, ENDED_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state.phase, calls]);

  if (!calls || state.phase === 'idle' || !state.peer) return null;

  const video = state.media === 'VIDEO';
  const name = state.peer.displayName || formatOgcIdForDisplay(state.peer.ogcId);
  const status = callStatusText(state, now);
  const inCall = state.phase === 'connecting' || state.phase === 'active';
  const showRemoteVideo = video && inCall && state.remoteStream !== null && !state.remoteCameraOff;
  const showLocalVideo = video && state.localStream !== null && !state.cameraOff;
  const ringing =
    state.phase === 'incoming' || state.phase === 'outgoing' || state.phase === 'connecting';
  const reconnecting =
    inCall && (state.reconnecting || (state.phase === 'active' && state.connectedAt === null));

  return (
    <div
      className={[styles.overlay, showRemoteVideo ? styles.withVideo : ''].join(' ')}
      // The call stage is always dark (video reads best on black), in the person's accent.
      data-theme="dark"
      data-accent={accent}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={statusId}
    >
      {/* Audio always plays through this element; the video elements are muted. */}
      <audio ref={remoteAudio} autoPlay className={styles.hidden} />
      {video ? (
        <video
          ref={remoteVideo}
          className={showRemoteVideo ? styles.remoteVideo : styles.hidden}
          autoPlay
          playsInline
          muted
          aria-label={`${name}’s video`}
        />
      ) : null}

      <div className={styles.identity}>
        <p className={styles.kind}>
          <Icon name={video ? 'video' : 'phone'} size={14} />
          {video ? 'Video call' : 'Voice call'}
          {state.phase === 'incoming' ? ' · Incoming' : ''}
        </p>
        {showRemoteVideo ? null : (
          <span className={[styles.avatarRing, ringing ? styles.ringing : ''].join(' ')}>
            <Avatar url={state.peer.avatarUrl} name={name} size={112} />
          </span>
        )}
        <h2 id={titleId} className={styles.name}>
          {name}
        </h2>
        {showRemoteVideo || !state.peer.ogcId ? null : (
          <p className={styles.ogcId}>{formatOgcIdForDisplay(state.peer.ogcId)}</p>
        )}
        <p
          id={statusId}
          className={[
            styles.status,
            state.phase === 'ended' ? styles.statusEnded : '',
            state.phase === 'active' && !reconnecting ? styles.timer : '',
            reconnecting ? styles.statusWarn : '',
          ].join(' ')}
          aria-live="polite"
        >
          {reconnecting ? <Icon name="refresh" size={16} className={styles.spin} /> : null}
          {status}
        </p>
        {inCall && state.remoteMicrophoneMuted ? (
          <p className={styles.note}>
            <Icon name="micOff" size={14} /> {name} is muted
          </p>
        ) : null}
        {inCall && video && state.remoteCameraOff ? (
          <p className={styles.note}>
            <Icon name="videoOff" size={14} /> Camera off
          </p>
        ) : null}
      </div>

      {showLocalVideo ? (
        <video
          ref={localVideo}
          className={[
            styles.localVideo,
            state.facing === 'user' ? styles.mirrored : '',
            state.phase === 'outgoing' || state.phase === 'incoming' ? styles.previewLarge : '',
          ].join(' ')}
          autoPlay
          playsInline
          muted
          aria-label="Your camera"
        />
      ) : null}

      <div className={styles.controls}>
        {state.phase === 'incoming' ? (
          <>
            <ControlButton
              label="Decline"
              icon="phoneOff"
              tone="danger"
              onClick={() => {
                void calls.decline();
              }}
            />
            <ControlButton
              label="Accept"
              icon={video ? 'video' : 'phone'}
              tone="accept"
              disabled={!state.supported}
              autoFocus={state.supported}
              onClick={() => {
                void calls.accept();
              }}
            />
          </>
        ) : null}
        {state.phase === 'outgoing' || inCall ? (
          <>
            <ControlButton
              label={state.microphoneMuted ? 'Unmute' : 'Mute'}
              icon={state.microphoneMuted ? 'micOff' : 'mic'}
              pressed={state.microphoneMuted}
              onClick={() => {
                calls.toggleMicrophone();
              }}
            />
            {video ? (
              <ControlButton
                label={state.cameraOff ? 'Turn camera on' : 'Turn camera off'}
                icon={state.cameraOff ? 'videoOff' : 'video'}
                pressed={state.cameraOff}
                onClick={() => {
                  calls.toggleCamera();
                }}
              />
            ) : null}
            {video && state.canSwitchCamera ? (
              <ControlButton
                label="Switch camera"
                icon="cameraSwitch"
                disabled={state.cameraOff}
                onClick={() => {
                  void calls.switchCamera();
                }}
              />
            ) : null}
            <ControlButton
              label={state.phase === 'outgoing' ? 'Cancel call' : 'End call'}
              icon="phoneOff"
              tone="danger"
              autoFocus
              onClick={() => {
                void calls.hangUp();
              }}
            />
          </>
        ) : null}
        {state.phase === 'ended' ? (
          <ControlButton
            label="Close"
            icon="close"
            autoFocus
            onClick={() => {
              calls.dismiss();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
