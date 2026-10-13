import { VOICE_MAX_DURATION_MS } from '@ogc/validation';
import { useEffect, useRef, useState } from 'react';
import { duration } from '../../messaging/format';
import styles from './messaging.module.css';

export interface RecordedVoice {
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
}

const CANDIDATE_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

function recorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
    return undefined;
  return CANDIDATE_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function explain(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it in your browser settings to record voice messages.';
  }
  if (name === 'NotFoundError') return 'No microphone was found on this device.';
  return 'Recording could not start.';
}

/**
 * Records a voice message with the browser's MediaRecorder: record, stop,
 * cancel. Audio stays on this device until it is encrypted and sent.
 */
export function VoiceRecorder({
  onRecorded,
  onError,
}: {
  onRecorded: (voice: RecordedVoice) => void;
  onError: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const startedAt = useRef(0);
  const supported =
    typeof navigator !== 'undefined' && 'mediaDevices' in navigator && recorderMime() !== undefined;

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= VOICE_MAX_DURATION_MS) recorder.current?.stop();
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, [recording]);

  useEffect(
    () => () => {
      cancelled.current = true;
      recorder.current?.stop();
    },
    [],
  );

  const start = async () => {
    const mimeType = recorderMime();
    if (!supported || !mimeType) {
      onError('Voice messages aren’t supported in this browser.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      onError(explain(error));
      return;
    }
    const chunks: Blob[] = [];
    const instance = new MediaRecorder(stream, { mimeType });
    instance.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    instance.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      setRecording(false);
      if (cancelled.current) return;
      const durationMs = Math.min(Date.now() - startedAt.current, VOICE_MAX_DURATION_MS);
      // Declared type without codec parameters (validated as a plain media type).
      const mime = mimeType.split(';')[0] ?? 'audio/webm';
      void new Blob(chunks).arrayBuffer().then((buffer) => {
        onRecorded({ bytes: new Uint8Array(buffer), mime, durationMs });
      });
    };
    recorder.current = instance;
    cancelled.current = false;
    startedAt.current = Date.now();
    setElapsed(0);
    instance.start(250);
    setRecording(true);
  };

  if (!recording) {
    return (
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Record a voice message"
        onClick={() => void start()}
      >
        🎙
      </button>
    );
  }
  return (
    <div className={styles.recording} role="group" aria-label="Recording voice message">
      <span className={styles.recDot} aria-hidden="true" />
      <span className={styles.recTime} aria-live="off">
        {duration(elapsed)}
      </span>
      <button
        type="button"
        className={styles.linkButton}
        onClick={() => {
          cancelled.current = true;
          recorder.current?.stop();
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        className={styles.smallButton}
        onClick={() => {
          recorder.current?.stop();
        }}
      >
        Stop
      </button>
    </div>
  );
}
