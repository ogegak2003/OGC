import type { LocalMessage } from '@ogc/messaging';
import {
  ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_TEXT_MAX_LENGTH,
} from '@ogc/validation';
import { useEffect, useRef, useState } from 'react';
import { attachmentKind, duration, fileSize, safeFileName } from '../../messaging/format';
import { previewText } from '../../messaging/hooks';
import styles from './messaging.module.css';
import { type RecordedVoice, VoiceRecorder } from './VoiceRecorder';

const EMOJI = [
  '😀',
  '😂',
  '😊',
  '😍',
  '🤔',
  '😮',
  '😢',
  '😡',
  '👍',
  '👏',
  '🙏',
  '🎉',
  '❤️',
  '🔥',
  '✨',
  '✅',
  '👋',
  '🤝',
  '💡',
  '📌',
];

export interface PendingFile {
  id: string;
  file: File;
}

export interface ComposerSubmit {
  text: string;
  files: File[];
  voice: RecordedVoice | null;
}

/**
 * Message composer: Enter sends, Shift+Enter adds a line, Escape cancels a
 * reply or edit. Typing indicators are throttled and stop automatically.
 */
export function Composer({
  disabled,
  replyTo,
  editing,
  onCancelContext,
  onSubmit,
  onTyping,
  onError,
}: {
  disabled: boolean;
  replyTo: LocalMessage | null;
  editing: LocalMessage | null;
  onCancelContext: () => void;
  onSubmit: (input: ComposerSubmit) => Promise<void>;
  onTyping: (typing: boolean) => void;
  onError: (message: string) => void;
}) {
  // Remounted (keyed) per edit, so an edit starts from the message's current text.
  const [text, setText] = useState(editing?.payload?.text ?? '');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [voice, setVoice] = useState<RecordedVoice | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingSince = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  useEffect(
    () => () => {
      clearTimeout(stopTimer.current);
    },
    [],
  );

  const signalTyping = (value: string) => {
    clearTimeout(stopTimer.current);
    if (!value.trim()) {
      if (typingSince.current) onTyping(false);
      typingSince.current = 0;
      return;
    }
    const now = Date.now();
    if (now - typingSince.current > 3_000) {
      typingSince.current = now;
      onTyping(true);
    }
    stopTimer.current = setTimeout(() => {
      typingSince.current = 0;
      onTyping(false);
    }, 5_000);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const accepted: PendingFile[] = [];
    for (const file of list) {
      const kind = attachmentKind(file.type);
      if (file.size === 0) continue;
      if (file.size > ATTACHMENT_MAX_BYTES[kind]) {
        onError(
          `${safeFileName(file.name)} is larger than ${fileSize(ATTACHMENT_MAX_BYTES[kind])}.`,
        );
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), file });
    }
    setFiles((current) => [...current, ...accepted].slice(0, MESSAGE_ATTACHMENTS_MAX));
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (busy || disabled || (!trimmed && files.length === 0 && !voice)) return;
    setBusy(true);
    try {
      await onSubmit({ text: trimmed, files: files.map((f) => f.file), voice });
      setText('');
      setFiles([]);
      setVoice(null);
      typingSince.current = 0;
      clearTimeout(stopTimer.current);
      onTyping(false);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const context = editing ?? replyTo;
  return (
    <div className={styles.composer}>
      {context ? (
        <div className={styles.context}>
          <span className={styles.contextLabel}>{editing ? 'Editing' : 'Replying to'}</span>
          <span className={styles.contextText}>{previewText(context)}</span>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onCancelContext}
            aria-label={editing ? 'Cancel edit' : 'Cancel reply'}
          >
            ✕
          </button>
        </div>
      ) : null}
      {files.length > 0 || voice ? (
        <ul className={styles.pending} aria-label="Attachments to send">
          {files.map((pending) => (
            <li key={pending.id} className={styles.pendingItem}>
              <span>
                {safeFileName(pending.file.name)} · {fileSize(pending.file.size)}
              </span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Remove ${safeFileName(pending.file.name)}`}
                onClick={() => {
                  setFiles((current) => current.filter((f) => f.id !== pending.id));
                }}
              >
                ✕
              </button>
            </li>
          ))}
          {voice ? (
            <li className={styles.pendingItem}>
              <span>Voice message · {duration(voice.durationMs)}</span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Discard voice message"
                onClick={() => {
                  setVoice(null);
                }}
              >
                ✕
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {emojiOpen ? (
        <div className={styles.emojiPanel} role="group" aria-label="Emoji">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={styles.pick}
              aria-label={`Insert ${emoji}`}
              onClick={() => {
                const element = input.current;
                const start = element?.selectionStart ?? text.length;
                const end = element?.selectionEnd ?? text.length;
                const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
                setText(next);
                setEmojiOpen(false);
                element?.focus();
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.composeRow}>
        {!editing ? (
          <>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Attach files"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              ＋
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </>
        ) : null}
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Emoji"
          aria-expanded={emojiOpen}
          disabled={disabled}
          onClick={() => {
            setEmojiOpen((open) => !open);
          }}
        >
          ☺
        </button>
        <textarea
          ref={input}
          className={styles.input}
          rows={1}
          maxLength={MESSAGE_TEXT_MAX_LENGTH}
          placeholder={disabled ? 'You can’t send messages here' : 'Encrypted message'}
          aria-label="Message"
          disabled={disabled}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            signalTyping(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape' && context) {
              setText('');
              onCancelContext();
            }
          }}
        />
        {!editing && !text.trim() && files.length === 0 && !voice && !disabled ? (
          <VoiceRecorder onRecorded={setVoice} onError={onError} />
        ) : (
          <button
            type="button"
            className={styles.sendButton}
            onClick={() => void submit()}
            disabled={disabled || busy}
            aria-label={editing ? 'Save edit' : 'Send'}
          >
            {editing ? 'Save' : 'Send'}
          </button>
        )}
      </div>
      <p className={styles.e2eeNote}>
        <span aria-hidden="true">🔒</span> End-to-end encrypted
      </p>
    </div>
  );
}
