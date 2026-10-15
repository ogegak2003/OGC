import type { CallMediaPlatform, CameraFacing, PeerConnectionLike } from '@ogc/messaging';

/**
 * Browser WebRTC for calls. Browsers only expose the camera and microphone in a secure
 * context (HTTPS, or `localhost` during development), so on plain HTTP this returns
 * `undefined` and the app explains that calls are unavailable instead of failing later.
 */
export function browserCallMedia(): CallMediaPlatform | undefined {
  if (typeof RTCPeerConnection === 'undefined' || typeof navigator === 'undefined') {
    return undefined;
  }
  // Browsers expose the camera and microphone only in secure contexts (HTTPS, localhost).
  if (!window.isSecureContext) return undefined;
  const devices = navigator.mediaDevices;
  const cameras = async () =>
    (await devices.enumerateDevices()).filter((device) => device.kind === 'videoinput');

  return {
    getUserMedia: async (request) =>
      await devices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: request.video
          ? {
              facingMode: request.video.facingMode,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
      }),
    createPeerConnection: (config) =>
      new RTCPeerConnection({
        iceServers: config.iceServers,
        iceTransportPolicy: config.iceTransportPolicy,
      }) as unknown as PeerConnectionLike,
    canSwitchCamera: async () => (await cameras()).length > 1,
    switchCamera: async (stream, peer, current): Promise<CameraFacing | undefined> => {
      const media = stream as unknown as MediaStream;
      const old = media.getVideoTracks()[0];
      const list = await cameras();
      if (!old || list.length < 2) return undefined;
      // Cycle through the cameras by device ID (laptops have no "front"/"rear" facing mode).
      const index = list.findIndex((d) => d.deviceId === old.getSettings().deviceId);
      const next = list[(index + 1) % list.length];
      if (!next) return undefined;
      const fresh = await devices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } });
      const track = fresh.getVideoTracks()[0];
      if (!track) return undefined;
      track.enabled = old.enabled;
      for (const sender of (peer as unknown as RTCPeerConnection | null)?.getSenders() ?? []) {
        if (sender.track?.kind === 'video') await sender.replaceTrack(track);
      }
      media.removeTrack(old);
      old.stop();
      media.addTrack(track);
      return current === 'user' ? 'environment' : 'user';
    },
  };
}
