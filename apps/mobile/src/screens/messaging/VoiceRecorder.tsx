import { duration } from '@ogc/messaging';
import { VOICE_MAX_DURATION_MS } from '@ogc/validation';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { m } from './styles';

export interface RecordedVoice {
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
}

/**
 * Voice messages: record, stop, cancel. Recording needs microphone permission;
 * a refusal is explained, never retried silently. The recording file is read
 * into memory for encryption and then deleted.
 */
export function VoiceRecorder({
  onRecorded,
  onError,
}: {
  onRecorded: (voice: RecordedVoice) => void;
  onError: (message: string) => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setElapsed(Math.min(Date.now() - startedAt.current, VOICE_MAX_DURATION_MS));
    }, 250);
    return () => {
      clearInterval(timer);
    };
  });

  const start = async () => {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        onError('Microphone access is off. Turn it on in Settings to record voice messages.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      // The recorder stops by itself at the maximum length.
      recorder.record({ forDuration: VOICE_MAX_DURATION_MS / 1000 });
      startedAt.current = Date.now();
      setElapsed(0);
      setRecording(true);
    } catch {
      onError('Recording could not start on this device.');
    }
  };

  const finish = async (keep: boolean) => {
    setRecording(false);
    await recorder.stop().catch(() => undefined);
    await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    const uri = recorder.uri;
    if (!uri) return;
    const file = new File(uri);
    try {
      if (keep) {
        const bytes = new Uint8Array(await file.bytes());
        onRecorded({
          bytes,
          mime: 'audio/mp4',
          durationMs: Math.min(Date.now() - startedAt.current, VOICE_MAX_DURATION_MS),
        });
      }
    } finally {
      if (file.exists) file.delete();
    }
  };

  if (!recording) {
    return (
      <Text
        style={m.icon}
        accessibilityRole="button"
        accessibilityLabel="Record a voice message"
        onPress={() => void start()}
      >
        🎙
      </Text>
    );
  }
  return (
    <View style={m.recording} accessibilityLabel="Recording voice message">
      <View style={m.recDot} />
      <Text style={m.metaText}>{duration(elapsed)}</Text>
      <Text
        style={[m.contextLabel, { marginLeft: 'auto' }]}
        accessibilityRole="button"
        onPress={() => void finish(false)}
      >
        Cancel
      </Text>
      <Text style={m.send} accessibilityRole="button" onPress={() => void finish(true)}>
        Stop
      </Text>
    </View>
  );
}
