import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  MESSAGE_CIPHERTEXT_MAX_BYTES,
  attachmentNameSchema,
  base64Schema,
  commitRequestSchema,
  deleteMessageQuerySchema,
  historyQuerySchema,
  messagePayloadSchema,
  presenceSubscriptionSchema,
  pushTokenRequestSchema,
  reactionTypeSchema,
  receiptRequestSchema,
  registerDeviceKeyRequestSchema,
  sendMessageRequestSchema,
  syncQuerySchema,
  typingEventSchema,
} from './messaging.js';

const uuid = '0d4c9f5e-8a5b-4c1e-9a7d-3f2b1c0e9d8a';
/** base64 of `n` zero bytes. */
const b64 = (n: number): string =>
  'A'.repeat(Math.floor(n / 3) * 4) + (['', 'AA==', 'AAA='][n % 3] ?? '');

const attachment = {
  id: uuid,
  kind: 'IMAGE' as const,
  name: 'holiday.jpg',
  mime: 'image/jpeg',
  size: 1024,
  key: b64(32),
  nonce: b64(24),
  digest: b64(32),
};

describe('message request envelopes', () => {
  it('accepts a well-formed send request', () => {
    const parsed = sendMessageRequestSchema.parse({
      clientMessageId: uuid,
      epoch: 3,
      ciphertext: b64(100),
      replyToId: uuid,
      attachmentIds: [uuid],
    });
    expect(parsed.epoch).toBe(3);
  });

  it('rejects unknown fields (no mass assignment of sender, status or seq)', () => {
    for (const extra of [
      { senderId: uuid },
      { status: 'READ' },
      { seq: 1 },
      { conversationId: uuid },
    ]) {
      expect(
        sendMessageRequestSchema.safeParse({
          clientMessageId: uuid,
          epoch: 0,
          ciphertext: b64(10),
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it('enforces ciphertext size and strict base64', () => {
    const tooBig = b64(MESSAGE_CIPHERTEXT_MAX_BYTES + 3);
    expect(
      sendMessageRequestSchema.safeParse({ clientMessageId: uuid, epoch: 0, ciphertext: tooBig })
        .success,
    ).toBe(false);
    for (const bad of ['abc', '<script>', 'YWJj\n', 'YW=j']) {
      expect(base64Schema(100).safeParse(bad).success).toBe(false);
    }
    expect(base64Schema(100).safeParse(b64(10)).success).toBe(true);
  });

  it('rejects malformed identifiers and negative or fractional counters', () => {
    expect(
      sendMessageRequestSchema.safeParse({ clientMessageId: 'x', epoch: 0, ciphertext: b64(4) })
        .success,
    ).toBe(false);
    expect(receiptRequestSchema.safeParse({ seq: 0 }).success).toBe(false);
    expect(receiptRequestSchema.safeParse({ seq: 1.5 }).success).toBe(false);
    expect(receiptRequestSchema.safeParse({ seq: 5 }).success).toBe(true);
  });

  it('bounds sync and history pages and forbids ambiguous cursors', () => {
    expect(syncQuerySchema.parse({})).toEqual({ after: 0, limit: 100 });
    expect(syncQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ before: '10', after: '2' }).success).toBe(false);
    expect(historyQuerySchema.parse({ before: '10' })).toEqual({ before: 10, limit: 50 });
  });

  it('accepts only the controlled reaction set and delete scopes', () => {
    expect(reactionTypeSchema.safeParse('heart').success).toBe(true);
    expect(reactionTypeSchema.safeParse('💩').success).toBe(false);
    expect(deleteMessageQuerySchema.safeParse({ scope: 'everyone' }).success).toBe(true);
    expect(deleteMessageQuerySchema.safeParse({ scope: 'all' }).success).toBe(false);
  });

  it('validates device keys, commits, push tokens and realtime events', () => {
    expect(registerDeviceKeyRequestSchema.safeParse({ signaturePublicKey: b64(32) }).success).toBe(
      true,
    );
    expect(registerDeviceKeyRequestSchema.safeParse({ signaturePublicKey: b64(31) }).success).toBe(
      false,
    );
    expect(
      commitRequestSchema.safeParse({ epoch: 0, commit: b64(10), groupInfo: b64(10) }).success,
    ).toBe(true);
    expect(
      pushTokenRequestSchema.safeParse({ provider: 'EXPO', token: 'ExponentPushToken[abc]' })
        .success,
    ).toBe(true);
    expect(pushTokenRequestSchema.safeParse({ provider: 'EXPO', token: 'has space' }).success).toBe(
      false,
    );
    expect(typingEventSchema.safeParse({ conversationId: uuid, userId: uuid }).success).toBe(false);
    expect(presenceSubscriptionSchema.safeParse({ ogcIds: ['OGC482731905'] }).success).toBe(true);
    expect(presenceSubscriptionSchema.safeParse({ ogcIds: ['482731905'] }).success).toBe(false);
  });
});

describe('decrypted message payloads', () => {
  it('accepts text, attachments, or both', () => {
    expect(messagePayloadSchema.safeParse({ v: 1, text: 'Hello' }).success).toBe(true);
    expect(messagePayloadSchema.safeParse({ v: 1, attachments: [attachment] }).success).toBe(true);
    expect(
      messagePayloadSchema.safeParse({ v: 1, text: 'caption', attachments: [attachment] }).success,
    ).toBe(true);
  });

  it('rejects empty, oversized, unknown-version and extended payloads', () => {
    expect(messagePayloadSchema.safeParse({ v: 1, text: '   ' }).success).toBe(false);
    expect(messagePayloadSchema.safeParse({ v: 2, text: 'hi' }).success).toBe(false);
    expect(messagePayloadSchema.safeParse({ v: 1, text: 'x'.repeat(4001) }).success).toBe(false);
    expect(messagePayloadSchema.safeParse({ v: 1, text: 'hi', html: '<b>x</b>' }).success).toBe(
      false,
    );
    expect(
      messagePayloadSchema.safeParse({
        v: 1,
        attachments: [{ ...attachment, size: ATTACHMENT_MAX_BYTES.IMAGE + 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects control characters and bidirectional overrides used for spoofing', () => {
    expect(messagePayloadSchema.safeParse({ v: 1, text: 'line one\nline two\ttab' }).success).toBe(
      true,
    );
    expect(messagePayloadSchema.safeParse({ v: 1, text: 'bell\u0007' }).success).toBe(false);
    expect(messagePayloadSchema.safeParse({ v: 1, text: 'invoice‮txt.exe' }).success).toBe(false);
  });

  it('accepts only safe attachment names and media types', () => {
    for (const name of [
      '../../etc/passwd',
      'a/b.txt',
      'a\\b.txt',
      '..',
      'evil‮gpj.exe',
      'new\nline.txt',
    ]) {
      expect(attachmentNameSchema.safeParse(name).success).toBe(false);
    }
    expect(attachmentNameSchema.safeParse('Résumé 2026 (final).pdf').success).toBe(true);
    expect(
      messagePayloadSchema.safeParse({
        v: 1,
        attachments: [{ ...attachment, mime: 'text/html; charset=utf-8' }],
      }).success,
    ).toBe(false);
  });
});
