import { detectImageMime } from '@ogc/messaging';
import type { AttachmentDescriptor } from '@ogc/validation';
import { useEffect, useRef, useState } from 'react';
import { duration, fileSize, playableAudio, safeFileName } from '../../messaging/format';
import { useMessaging } from '../../messaging/messaging-context';
import styles from './messaging.module.css';

type Decrypted = { ok: true; url: string; mime: string } | { ok: false };

/**
 * Downloads and decrypts an attachment once it is requested. The object URL
 * is revoked when the component unmounts. Rendering never trusts the declared
 * media type: inline images must really be raster images, audio must be a
 * known audio type, everything else is offered as an opaque download.
 */
function useDecrypted(descriptor: AttachmentDescriptor, requested: boolean): Decrypted | undefined {
  const { engine } = useMessaging();
  const [result, setResult] = useState<Decrypted>();

  useEffect(() => {
    if (!requested || !engine) return;
    let active = true;
    let url: string | undefined;
    engine.openAttachment(descriptor).then(
      (bytes) => {
        const sniffed = descriptor.kind === 'IMAGE' ? detectImageMime(bytes) : undefined;
        const audio =
          (descriptor.kind === 'VOICE' || descriptor.kind === 'AUDIO') &&
          playableAudio(descriptor.mime)
            ? descriptor.mime
            : undefined;
        const mime = sniffed ?? audio ?? 'application/octet-stream';
        url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mime }));
        if (active) setResult({ ok: true, url, mime });
      },
      () => {
        if (active) setResult({ ok: false });
      },
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [requested, engine, descriptor]);

  return result;
}

function FileAttachment({ descriptor }: { descriptor: AttachmentDescriptor }) {
  const [requested, setRequested] = useState(false);
  const result = useDecrypted(descriptor, requested);
  const name = safeFileName(descriptor.name);
  const saved = useRef(false);

  useEffect(() => {
    if (!result?.ok || saved.current) return;
    saved.current = true;
    const anchor = document.createElement('a');
    anchor.href = result.url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.click();
  }, [result, name]);

  const busy = requested && !result;
  return (
    <div className={styles.file}>
      <span className={styles.fileIcon} aria-hidden="true">
        ⎙
      </span>
      <span className={styles.fileMeta}>
        <span className={styles.fileName}>{name}</span>
        <span className={styles.fileSize}>{fileSize(descriptor.size)}</span>
      </span>
      <button
        type="button"
        className={styles.smallButton}
        disabled={busy}
        onClick={() => {
          saved.current = false;
          setRequested(true);
        }}
        aria-label={`Download ${name}`}
      >
        {busy ? 'Decrypting…' : result && !result.ok ? 'Unavailable' : 'Download'}
      </button>
    </div>
  );
}

function ImageAttachment({ descriptor }: { descriptor: AttachmentDescriptor }) {
  const result = useDecrypted(descriptor, true);
  if (!result) {
    return (
      <div className={styles.imagePlaceholder} role="status">
        Decrypting photo…
      </div>
    );
  }
  if (result.ok && result.mime.startsWith('image/')) {
    return (
      <img
        className={styles.image}
        src={result.url}
        alt={`Photo: ${safeFileName(descriptor.name)}`}
      />
    );
  }
  if (!result.ok) {
    return <div className={styles.imagePlaceholder}>Photo unavailable</div>;
  }
  // Declared as a photo but not actually an image: offer it as a file instead.
  return <FileAttachment descriptor={descriptor} />;
}

function VoiceAttachment({ descriptor }: { descriptor: AttachmentDescriptor }) {
  const [requested, setRequested] = useState(false);
  const result = useDecrypted(descriptor, requested);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const total = descriptor.durationMs ?? 0;
  const ready = result?.ok === true;

  useEffect(() => {
    if (result?.ok && audio.current && audio.current.src !== result.url) {
      audio.current.src = result.url;
      void audio.current.play().catch(() => undefined);
    }
  }, [result]);

  return (
    <div className={styles.voice}>
      <button
        type="button"
        className={styles.playButton}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        disabled={requested && !result}
        onClick={() => {
          if (!requested) {
            setRequested(true);
            return;
          }
          const element = audio.current;
          if (!element) return;
          if (element.paused) void element.play().catch(() => undefined);
          else element.pause();
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        className={styles.seek}
        min={0}
        max={Math.max(1, total)}
        step={100}
        value={position}
        aria-label="Seek"
        disabled={!ready}
        onChange={(event) => {
          const next = Number(event.target.value);
          setPosition(next);
          if (audio.current) audio.current.currentTime = next / 1000;
        }}
      />
      <span className={styles.voiceTime}>{duration(position || total)}</span>
      {result && !result.ok ? <span className={styles.attachmentError}>Unavailable</span> : null}
      <audio
        ref={audio}
        preload="none"
        onPlay={() => {
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(event) => {
          setPosition(Math.round(event.currentTarget.currentTime * 1000));
        }}
      />
    </div>
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
