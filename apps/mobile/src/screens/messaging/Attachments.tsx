import { toBase64 } from '@ogc/e2ee';
import { detectImageMime, duration, fileSize, playableAudio, safeFileName } from '@ogc/messaging';
import type { AttachmentDescriptor } from '@ogc/validation';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';

import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { useMessaging } from '../../messaging/messaging-context';
import { cacheFile } from '../../messaging/native-store';
import { m } from './styles';
import { color } from '../../theme';

/**
 * Decrypted photos are shown from memory (a data URI), never written to disk.
 * Only real raster images are displayed — the declared type is not trusted.
 */
function ImageAttachment({ descriptor }: { descriptor: AttachmentDescriptor }) {
  const { engine } = useMessaging();
  const [uri, setUri] = useState<string | null>();

  useEffect(() => {
    if (!engine) return;
    let active = true;
    engine.openAttachment(descriptor).then(
      (bytes) => {
        const mime = detectImageMime(bytes);
        if (active) setUri(mime ? `data:${mime};base64,${toBase64(bytes)}` : null);
      },
      () => {
        if (active) setUri(null);
      },
    );
    return () => {
      active = false;
    };
  }, [engine, descriptor]);

  if (uri === undefined) {
    return (
      <View style={[m.image, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={color.accent} accessibilityLabel="Decrypting photo" />
      </View>
    );
  }
  if (uri === null) return <FileAttachment descriptor={descriptor} />;
  return (
    <Image
      source={{ uri }}
      style={m.image}
      accessibilityLabel={`Photo: ${safeFileName(descriptor.name)}`}
    />
  );
}

/**
 * Files are decrypted on demand into the app's private cache and handed to the
 * system share sheet (to save or open in another app); the copy is deleted afterwards.
 */
function FileAttachment({ descriptor }: { descriptor: AttachmentDescriptor }) {
  const { engine } = useMessaging();
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const name = safeFileName(descriptor.name);

  const open = async () => {
    if (!engine) return;
    setState('busy');
    let file: File | undefined;
    try {
      const bytes = await engine.openAttachment(descriptor);
      file = cacheFile(bytes, 'bin');
      await Sharing.shareAsync(file.uri, {
        dialogTitle: name,
        mimeType: 'application/octet-stream',
      });
      setState('idle');
    } catch {
      setState('error');
    } finally {
      if (file?.exists) file.delete();
    }
  };

  return (
    <View style={m.file}>
      <View style={m.fileIcon}>
        <Icon name="file" size={20} tint={color.accent} />
      </View>
      <View style={m.fileBody}>
        <Text style={m.fileName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={m.fileSize}>{fileSize(descriptor.size)}</Text>
      </View>
      <Text
        style={m.fileAction}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}`}
        onPress={() => void open()}
      >
        {state === 'busy' ? 'Decrypting…' : state === 'error' ? 'Unavailable' : 'Open'}
      </Text>
    </View>
  );
}

function VoicePlayer({ source, total }: { source: string; total: number }) {
  const player = useAudioPlayer({ uri: source });
  const status = useAudioPlayerStatus(player);
  const position = Math.round(status.currentTime * 1000);
  return (
    <View style={m.file}>
      <Pressable
        style={m.play}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause voice message' : 'Play voice message'}
        onPress={() => {
          if (status.playing) player.pause();
          else player.play();
        }}
      >
        <Icon
          name={status.playing ? 'pause' : 'play'}
          size={18}
          tint={color.onAccent}
          strokeWidth={2.25}
        />
      </Pressable>
      <Pressable
        style={{ flex: 1 }}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek"
        accessibilityValue={{ min: 0, max: Math.max(1, total), now: position }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          const step = event.nativeEvent.actionName === 'increment' ? 5 : -5;
          void player.seekTo(Math.max(0, status.currentTime + step));
        }}
        onPress={() => void player.seekTo(0)}
      >
        <Text style={m.fileSize}>{duration(position || total)}</Text>
      </Pressable>
    </View>
  );
}

/** Voice notes are decrypted into the private cache for playback and deleted on unmount. */
function VoiceAttachment({ descriptor }: { descriptor: AttachmentDescriptor }) {
  const { engine } = useMessaging();
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(
    () => () => {
      if (file?.exists) file.delete();
    },
    [file],
  );

  if (file) return <VoicePlayer source={file.uri} total={descriptor.durationMs ?? 0} />;
  return (
    <View style={m.file}>
      <Pressable
        style={m.play}
        accessibilityRole="button"
        accessibilityLabel="Play voice message"
        onPress={() => {
          if (!engine) return;
          engine.openAttachment(descriptor).then(
            (bytes) => {
              setFile(cacheFile(bytes, descriptor.mime === 'audio/webm' ? 'webm' : 'm4a'));
            },
            () => {
              setFailed(true);
            },
          );
        }}
      >
        <Icon name="play" size={18} tint={color.onAccent} strokeWidth={2.25} />
      </Pressable>
      <Text style={m.fileSize}>
        {failed ? 'Unavailable' : `Voice message · ${duration(descriptor.durationMs ?? 0)}`}
      </Text>
    </View>
  );
}

export function AttachmentView({ descriptor }: { descriptor: AttachmentDescriptor }) {
  if (descriptor.kind === 'IMAGE') return <ImageAttachment descriptor={descriptor} />;
  if (
    (descriptor.kind === 'VOICE' || descriptor.kind === 'AUDIO') &&
    playableAudio(descriptor.mime)
  ) {
    return <VoiceAttachment descriptor={descriptor} />;
  }
  return <FileAttachment descriptor={descriptor} />;
}
