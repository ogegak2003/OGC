import { callStatusText } from '@ogc/messaging';
import { fontSize, fontWeight, space } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { streamUrl, videoView } from '../../calls/native-call-media';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar } from '../../components/identity';
import { useCall } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { stage as color, themedStyles } from '../../theme';

/** The "call ended" screen closes itself after this long. */
const ENDED_DISMISS_MS = 3500;
const KEEP_AWAKE_TAG = 'ogc-call';
/** WebRTC's video view; undefined in Expo Go (resolved once: it never changes at run time). */
const VideoView = videoView();

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

function Control({
  label,
  icon,
  onPress,
  selected,
  tone = 'neutral',
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  selected?: boolean;
  tone?: 'neutral' | 'danger' | 'accept';
  disabled?: boolean;
}) {
  const tint =
    tone === 'danger'
      ? '#FFFFFF'
      : tone === 'accept'
        ? color.onAccent
        : selected
          ? '#0B0B0D'
          : '#FFFFFF';
  return (
    <View style={styles.control}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
        disabled={disabled}
        onPress={onPress}
        hitSlop={8}
        style={({ pressed }) => [
          styles.round,
          tone === 'danger' && styles.danger,
          tone === 'accept' && styles.accept,
          selected && styles.selected,
          pressed && styles.pressed,
          disabled && styles.disabled,
        ]}
      >
        <Icon name={icon} size={28} tint={tint} />
      </Pressable>
      <Text style={styles.controlLabel} numberOfLines={1} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Full-screen call interface over the signed-in app: incoming call (caller and call type),
 * outgoing ("Calling…"), connecting, the call itself, and how it ended. The timer starts only
 * when media connects; failures say why. Android's back button never drops a call.
 */
export function CallScreen() {
  const { calls } = useMessaging();
  const state = useCall();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const now = useNow(state.phase === 'active');
  const visible = calls !== undefined && state.phase !== 'idle' && state.peer !== null;
  const inCall = state.phase === 'connecting' || state.phase === 'active';

  // Keep the screen on for the whole call (a video call must not go dark mid-sentence).
  useEffect(() => {
    if (!visible || state.phase === 'ended') return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    };
  }, [visible, state.phase]);

  // Back does not hang up; on the "ended" screen it closes it.
  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (state.phase === 'ended') calls.dismiss();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [visible, state.phase, calls]);

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

  const peer = state.peer;
  const video = state.media === 'VIDEO';
  const name = peer.displayName || formatOgcIdForDisplay(peer.ogcId);
  const status = callStatusText(state, now);
  const remoteUrl = streamUrl(state.remoteStream);
  const localUrl = streamUrl(state.localStream);
  const showRemoteVideo =
    video && inCall && !state.remoteCameraOff && VideoView !== undefined && remoteUrl !== undefined;
  const showLocalVideo =
    video && !state.cameraOff && VideoView !== undefined && localUrl !== undefined;
  const previewWidth = Math.min(width * (inCall ? 0.28 : 0.4), 160);
  const reconnecting =
    inCall && (state.reconnecting || (state.phase === 'active' && state.connectedAt === null));

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.screen, showRemoteVideo && styles.videoScreen]}
      accessibilityViewIsModal
      importantForAccessibility="yes"
    >
      {showRemoteVideo ? (
        <VideoView streamURL={remoteUrl} style={StyleSheet.absoluteFill} objectFit="cover" />
      ) : (
        <View style={styles.glow} pointerEvents="none" />
      )}

      <View
        style={[
          styles.identity,
          { paddingTop: insets.top + space[10] },
          showRemoteVideo && styles.identityOverVideo,
          showRemoteVideo && { marginTop: insets.top + space[3], paddingTop: space[2] },
        ]}
      >
        {showRemoteVideo ? null : (
          <View style={styles.kind}>
            <Icon name={video ? 'video' : 'phone'} size={13} tint={color.textSecondary} />
            <Text style={styles.kindText}>
              {video ? 'Video call' : 'Voice call'}
              {state.phase === 'incoming' ? ' · Incoming' : ''}
            </Text>
          </View>
        )}
        {showRemoteVideo ? null : (
          <View style={styles.avatarRing}>
            <Avatar url={peer.avatarUrl} name={name} size={112} />
          </View>
        )}
        <Text style={styles.name} accessibilityRole="header" numberOfLines={2}>
          {name}
        </Text>
        {showRemoteVideo || !peer.ogcId ? null : (
          <Text style={styles.ogcId}>{formatOgcIdForDisplay(peer.ogcId)}</Text>
        )}
        <Text
          style={[
            styles.status,
            state.phase === 'active' && !reconnecting && styles.timer,
            reconnecting && styles.reconnecting,
            state.phase === 'ended' && styles.statusEnded,
          ]}
          accessibilityLiveRegion="polite"
        >
          {status}
        </Text>
        {inCall && state.remoteMicrophoneMuted ? (
          <Text style={styles.note}>{name} is muted</Text>
        ) : null}
        {inCall && video && state.remoteCameraOff ? (
          <Text style={styles.note}>Camera off</Text>
        ) : null}
        {!state.supported &&
        (state.phase === 'incoming' || state.ending?.reason === 'unsupported') ? (
          <Text style={styles.note}>
            Calls need the OGC app build — they aren’t available in Expo Go.
          </Text>
        ) : null}
      </View>

      {showLocalVideo ? (
        <VideoView
          streamURL={localUrl}
          style={[
            styles.preview,
            { width: previewWidth, height: previewWidth * (4 / 3), bottom: insets.bottom + 150 },
          ]}
          objectFit="cover"
          mirror={state.facing === 'user'}
          zOrder={1}
        />
      ) : null}

      <View
        style={[
          styles.controls,
          { paddingBottom: insets.bottom + space[6] },
          showRemoteVideo && styles.controlsOverVideo,
        ]}
      >
        {state.phase === 'incoming' ? (
          <>
            <Control
              label="Decline"
              icon="phoneOff"
              tone="danger"
              onPress={() => {
                void calls.decline();
              }}
            />
            <Control
              label="Accept"
              icon={video ? 'video' : 'phone'}
              tone="accept"
              disabled={!state.supported}
              onPress={() => {
                void calls.accept();
              }}
            />
          </>
        ) : null}
        {state.phase === 'outgoing' || inCall ? (
          <View style={styles.toggles}>
            <Control
              label={state.microphoneMuted ? 'Unmute' : 'Mute'}
              icon={state.microphoneMuted ? 'micOff' : 'mic'}
              selected={state.microphoneMuted}
              onPress={() => {
                calls.toggleMicrophone();
              }}
            />
            {video ? (
              <Control
                label={state.cameraOff ? 'Camera on' : 'Camera off'}
                icon={state.cameraOff ? 'videoOff' : 'video'}
                selected={state.cameraOff}
                onPress={() => {
                  calls.toggleCamera();
                }}
              />
            ) : null}
            {video && state.canSwitchCamera ? (
              <Control
                label="Flip"
                icon="cameraSwitch"
                disabled={state.cameraOff}
                onPress={() => {
                  void calls.switchCamera();
                }}
              />
            ) : null}
            {Platform.OS === 'android' && state.supported ? (
              <Control
                label="Speaker"
                icon="speaker"
                selected={state.speakerOn}
                onPress={() => {
                  calls.toggleSpeaker();
                }}
              />
            ) : null}
          </View>
        ) : null}
        {state.phase === 'outgoing' || inCall ? (
          <Control
            label={state.phase === 'outgoing' ? 'Cancel' : 'End'}
            icon="phoneOff"
            tone="danger"
            onPress={() => {
              void calls.hangUp();
            }}
          />
        ) : null}
        {state.phase === 'ended' ? (
          <Control
            label="Close"
            icon="close"
            onPress={() => {
              calls.dismiss();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    screen: {
      zIndex: 100,
      elevation: 100,
      justifyContent: 'space-between',
      backgroundColor: color.background,
    },
    videoScreen: { backgroundColor: '#000000' },
    glow: {
      position: 'absolute',
      top: -160,
      alignSelf: 'center',
      width: 420,
      height: 420,
      borderRadius: 210,
      backgroundColor: color.accentSubtle,
    },
    identity: {
      alignItems: 'center',
      paddingHorizontal: space[6],
    },
    identityOverVideo: {
      alignSelf: 'center',
      paddingHorizontal: space[4],
      paddingBottom: space[2],
      borderRadius: 16,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
    },
    kind: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space[2],
      marginBottom: space[5],
      paddingHorizontal: space[3],
      paddingVertical: space[1],
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: 999,
      backgroundColor: color.surfaceRaised,
    },
    kindText: {
      color: color.textSecondary,
      fontSize: fontSize.xs,
      fontWeight: fontWeight.semibold,
    },
    avatarRing: {
      padding: 4,
      marginBottom: space[5],
      borderWidth: 1,
      borderColor: color.accent,
      borderRadius: 64,
    },
    name: {
      color: color.textPrimary,
      fontSize: fontSize['2xl'],
      fontWeight: fontWeight.semibold,
      textAlign: 'center',
    },
    ogcId: {
      marginTop: space[1],
      color: color.textMuted,
      fontSize: fontSize.sm,
      letterSpacing: 1,
      fontVariant: ['tabular-nums'],
    },
    status: {
      marginTop: space[3],
      color: color.textSecondary,
      fontSize: fontSize.lg,
      textAlign: 'center',
    },
    timer: { color: color.accent, fontVariant: ['tabular-nums'], letterSpacing: 1 },
    statusEnded: { color: color.textPrimary },
    reconnecting: { color: color.warning },
    note: {
      marginTop: space[2],
      color: color.textMuted,
      fontSize: fontSize.sm,
      textAlign: 'center',
    },
    preview: {
      position: 'absolute',
      right: space[4],
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.2)',
      borderRadius: 16,
      backgroundColor: '#111111',
    },
    controls: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      rowGap: space[5],
      columnGap: space[3],
      paddingHorizontal: space[4],
      paddingTop: space[4],
    },
    toggles: {
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      rowGap: space[4],
      columnGap: space[3],
    },
    controlsOverVideo: { backgroundColor: 'rgba(0, 0, 0, 0.45)' },
    control: { alignItems: 'center', width: 72, gap: space[2] },
    round: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.16)',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
    },
    selected: { backgroundColor: '#F4F1EA', borderColor: '#F4F1EA' },
    danger: { backgroundColor: '#C8322A', borderColor: '#C8322A' },
    accept: { backgroundColor: color.accent, borderColor: color.accentHighlight },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.4 },
    controlLabel: { color: color.textSecondary, fontSize: fontSize.xs },
  }),
);
