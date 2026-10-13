import { fromUtf8, utf8 } from '@ogc/e2ee';
import type { MessageView, ReactionView } from '@ogc/types';
import { type MessagePayload, messagePayloadSchema } from '@ogc/validation';

/**
 * A message as stored on this device. `payload` is the decrypted content and
 * exists only locally (sealed at rest); the server only ever had ciphertext.
 */
export interface LocalMessage {
  /** Server ID once accepted; null while pending. */
  id: string | null;
  clientMessageId: string;
  conversationId: string;
  seq: number | null;
  version: number;
  senderOgcId: string | null;
  senderDeviceKeyId: string | null;
  mine: boolean;
  /**
   * - `pending` — created on this device, not yet accepted (in the outbox);
   * - `failed` — rejected by the server, will not be retried;
   * - `ok` — sent/received and readable;
   * - `deleted` — deleted for everyone;
   * - `unavailable` — sent before this device joined the conversation;
   * - `undecryptable` — could not be decrypted or failed validation.
   */
  state: 'pending' | 'failed' | 'ok' | 'deleted' | 'unavailable' | 'undecryptable';
  payload: MessagePayload | null;
  replyToId: string | null;
  forwarded: boolean;
  revision: number;
  editedAt: string | null;
  createdAt: string;
  reactions: ReactionView[];
  attachmentIds: string[];
}

export function encodePayload(payload: MessagePayload): Uint8Array {
  return utf8(JSON.stringify(messagePayloadSchema.parse(payload)));
}

/** Parses and validates decrypted content. Anything malformed is rejected, never rendered. */
export function decodePayload(bytes: Uint8Array): MessagePayload | undefined {
  try {
    const result = messagePayloadSchema.safeParse(JSON.parse(fromUtf8(bytes)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function fromServer(view: MessageView, myOgcId: string): LocalMessage {
  return {
    id: view.id,
    clientMessageId: view.clientMessageId,
    conversationId: view.conversationId,
    seq: view.seq,
    version: view.version,
    senderOgcId: view.sender.ogcId,
    senderDeviceKeyId: view.sender.deviceKeyId,
    mine: view.sender.ogcId === myOgcId,
    state: view.deletedAt ? 'deleted' : 'ok',
    payload: null,
    replyToId: view.replyToId,
    forwarded: view.forwarded,
    revision: view.revision,
    editedAt: view.editedAt,
    createdAt: view.createdAt,
    reactions: view.reactions,
    attachmentIds: view.attachments.map((a) => a.id),
  };
}

const IMAGE_SIGNATURES: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  },
  {
    mime: 'image/gif',
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/**
 * Detects a raster image format from its first bytes. Decrypted attachments
 * are only displayed inline when their content really is one of these
 * formats — never SVG or HTML — regardless of the declared type.
 */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  return IMAGE_SIGNATURES.find((s) => s.test(bytes))?.mime;
}

/** Case- and form-insensitive text used for local search. */
export function searchable(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase();
}
