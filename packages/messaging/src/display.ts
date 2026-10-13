import type { AttachmentKind, ConversationEventView, ConversationView } from '@ogc/types';
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

/** Name shown for a conversation: the group's name, or the other person's. */
export function conversationTitle(conversation: ConversationView): string {
  return conversation.group?.name ?? conversation.peer?.displayName ?? 'Conversation';
}

/** Photo for a conversation (group photo or the other person's), with the name for initials. */
export function conversationAvatar(conversation: ConversationView): {
  url: string | null;
  name: string;
} {
  return {
    url: conversation.group?.avatarUrl ?? conversation.peer?.avatarUrl ?? null,
    name: conversationTitle(conversation),
  };
}

/**
 * Members mentioned in a message, found on the sending device (`@Name` or an
 * OGC ID). Only their OGC IDs are sent beside the ciphertext, for notifications.
 */
export function mentionsIn(
  text: string,
  members: readonly { ogcId: string; displayName: string }[],
): string[] {
  const lowered = text.toLocaleLowerCase();
  const found = members.filter(
    (m) =>
      (m.displayName.trim() !== '' && lowered.includes(`@${m.displayName.toLocaleLowerCase()}`)) ||
      text.toUpperCase().includes(m.ogcId.toUpperCase()),
  );
  return [...new Set(found.map((m) => m.ogcId))].slice(0, 20);
}

/** One line describing a group timeline event ("Ada added Grace"). Never content. */
export function describeEvent(
  event: Pick<ConversationEventView, 'type' | 'actor' | 'subject' | 'detail'>,
  nameOf: (ogcId: string | null) => string,
  kind: 'GROUP' | 'CHANNEL' = 'GROUP',
): string {
  const actor = nameOf(event.actor);
  const subject = nameOf(event.subject);
  const noun = kind === 'CHANNEL' ? 'channel' : 'group';
  const role = typeof event.detail?.role === 'string' ? event.detail.role : '';
  switch (event.type) {
    case 'CREATED':
      return `${actor} created the ${noun}`;
    case 'MEMBER_JOINED':
      return `${subject} joined`;
    case 'MEMBER_LEFT':
      return `${subject} left`;
    case 'MEMBER_REMOVED':
      return `${actor} removed ${subject}`;
    case 'ROLE_CHANGED':
      return role === 'ADMIN'
        ? `${actor} made ${subject} an admin`
        : role === 'MODERATOR'
          ? `${actor} made ${subject} a moderator`
          : `${actor} changed ${subject}’s role to member`;
    case 'OWNERSHIP_TRANSFERRED':
      return `${actor} made ${subject} the owner`;
    case 'DETAILS_UPDATED':
      return `${actor} updated the ${noun} details`;
    case 'MESSAGE_REMOVED':
      return `${actor} removed a message`;
    case 'ARCHIVED':
      return `${actor} archived the ${noun}`;
    case 'UNARCHIVED':
      return `${actor} restored the ${noun}`;
  }
}
