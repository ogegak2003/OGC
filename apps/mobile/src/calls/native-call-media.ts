import type {
  CallMediaPlatform,
  CameraFacing,
  MediaStreamLike,
  MediaTrackLike,
  PeerConnectionLike,
} from '@ogc/messaging';
import { setAudioModeAsync } from 'expo-audio';
import type { ComponentType } from 'react';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

/** The parts of `react-native-webrtc` used here (loaded only where its native module exists). */
interface WebRtcModule {
  mediaDevices: {
    getUserMedia(constraints: unknown): Promise<MediaStreamLike>;
    enumerateDevices(): Promise<unknown>;
  };
  RTCPeerConnection: new (config: unknown) => PeerConnectionLike;
  RTCView: ComponentType<{
    streamURL: string;
    style?: unknown;
    objectFit?: 'contain' | 'cover';
    mirror?: boolean;
    zOrder?: number;
  }>;
}

let cached: WebRtcModule | null | undefined;

/**
 * `react-native-webrtc` is native code: it exists in OGC development and release builds, but
 * not in Expo Go. Its native module is checked *before* the package is loaded, because the
 * package itself only detects a `null` module (Expo Go reports `undefined`).
 */
export function loadWebRtc(): WebRtcModule | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const nativeModules = NativeModules as Record<string, unknown>;
  if (!nativeModules.WebRTCModule) {
    cached = null;
    return undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
    cached = require('react-native-webrtc') as WebRtcModule;
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

/** The video view component, where WebRTC is available. */
export function videoView(): WebRtcModule['RTCView'] | undefined {
  return loadWebRtc()?.RTCView;
}

/** A stream's native URL for `RTCView` (react-native-webrtc streams have `toURL()`). */
export function streamUrl(stream: MediaStreamLike | null): string | undefined {
  const url = (stream as { toURL?: () => string } | null)?.toURL?.();
  return typeof url === 'string' ? url : undefined;
}

function permissionDenied(): Error {
  const error = new Error('Permission denied');
  error.name = 'NotAllowedError';
  return error;
}

/**
 * Android asks at the moment of the call, with OGC's reason shown if the person declined
 * before. The camera is requested only for video calls. (iOS shows the usage descriptions
 * from app.config.ts when react-native-webrtc first opens the device.)
 */
async function ensureAndroidPermissions(video: boolean): Promise<void> {
  if (Platform.OS !== 'android') return;
  const microphone = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Microphone for calls',
    message: 'OGC uses your microphone during calls you make or answer.',
    buttonPositive: 'Continue',
  });
  if (microphone !== PermissionsAndroid.RESULTS.GRANTED) throw permissionDenied();
  if (!video) return;
  const camera = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
    title: 'Camera for video calls',
    message: 'OGC uses your camera only during video calls you make or answer.',
    buttonPositive: 'Continue',
  });
  if (camera !== PermissionsAndroid.RESULTS.GRANTED) throw permissionDenied();
}

/** Earpiece for voice calls, speaker for video (Android; iOS WebRTC manages its own session). */
function androidAudio(): CallMediaPlatform['audio'] {
  if (Platform.OS !== 'android') return undefined;
  const route = (speaker: boolean) => {
    void setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: 'doNotMix',
      shouldRouteThroughEarpiece: !speaker,
    }).catch(() => undefined);
  };
  return {
    start: (media) => {
      route(media === 'VIDEO');
    },
    setSpeaker: route,
    stop: () => {
      // Back to normal media playback (voice messages play through the speaker).
      route(true);
    },
  };
}

/** WebRTC for calls on this device, or `undefined` in Expo Go (no native module). */
export function nativeCallMedia(): CallMediaPlatform | undefined {
  const webrtc = loadWebRtc();
  if (!webrtc) return undefined;
  const audio = androidAudio();
  return {
    getUserMedia: async (request) => {
      await ensureAndroidPermissions(request.video !== false);
      return webrtc.mediaDevices.getUserMedia({
        audio: true,
        video: request.video
          ? { facingMode: request.video.facingMode, width: 1280, height: 720, frameRate: 30 }
          : false,
      });
    },
    createPeerConnection: (config) =>
      new webrtc.RTCPeerConnection({
        iceServers: config.iceServers,
        iceTransportPolicy: config.iceTransportPolicy,
      }),
    // Phones have front and rear cameras; react-native-webrtc switches in place.
    canSwitchCamera: () => Promise.resolve(true),
    switchCamera: async (stream, _peer, current): Promise<CameraFacing | undefined> => {
      const track = stream.getVideoTracks()[0] as
        | (MediaTrackLike & {
            applyConstraints?: (constraints: { facingMode: CameraFacing }) => Promise<void>;
          })
        | undefined;
      if (!track?.applyConstraints) return undefined;
      const next: CameraFacing = current === 'user' ? 'environment' : 'user';
      await track.applyConstraints({ facingMode: next });
      return next;
    },
    ...(audio ? { audio } : {}),
  };
}
