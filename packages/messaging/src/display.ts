import type { AttachmentKind } from '@ogc/types';
import type { LocalMessage } from './payload.js';

/**
 * Presentation rules shared by the web and mobile apps, so both treat
 * untrusted (decrypted) content identically.
 */

/** A one-line preview of a message, computed on the device (the server cannot read content). */
export function previewText(message: LocalMessage | undefined): string {
  if (!message) return 'No messages yet';
  switch (message.state) {
    case 'deleted':
      return 'Message deleted';
    case 'unavailable':
      return 'Encrypted message';
    case 'undecryptable':
      return 'Message could not be displayed';
    case 'failed':
      return 'Not sent';
    default:
      break;
  }
  const text = message.payload?.text?.trim();
  if (text) return text.replace(/\s+/g, ' ');
  const first = message.payload?.attachments?.[0];
  if (!first) return 'Message';
  switch (first.kind) {
    case 'IMAGE':
      return 'Photo';
    case 'VOICE':
      return 'Voice message';
    case 'AUDIO':
      return 'Audio';
    case 'VIDEO':
      return 'Video';
    default:
      return safeFileName(first.name);
  }
}

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
]);

const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Chooses the attachment kind from the platform-reported type (recipients re-check content). */
export function attachmentKind(mime: string): AttachmentKind {
  if (INLINE_IMAGE_TYPES.has(mime)) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (DOCUMENT_TYPES.has(mime)) return 'DOCUMENT';
  return 'FILE';
}

/** A media type safe to declare in a payload; anything unusual becomes a generic binary. */
export function safeMime(mime: string): string {
  return mime.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

/**
 * Display- and download-safe file name: strips paths, control and
 * bidirectional-override characters (used to disguise "txt.exe" as "exe.txt").
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/^.*[/\\]/, '')
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, '')
    .trim()
    .slice(0, 255);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

/** Audio types a client may play from decrypted bytes. */
export function playableAudio(mime: string): boolean {
  return /^audio\/(webm|ogg|mp4|mpeg|aac|wav|x-m4a)(;.*)?$/.test(mime);
}
