import { rawKeySealer, utf8 } from '@ogc/e2ee';
import { conversationAvatar, conversationTitle, describeEvent, mentionsIn } from './display.js';
import { describe, expect, it } from 'vitest';
import { KeyedLock } from './lock.js';
import {
  type LocalMessage,
  decodePayload,
  detectImageMime,
  encodePayload,
  searchable,
} from './payload.js';
import { messageStatus } from './status.js';
import { MemoryKeyValueStore, SealedStore } from './store.js';
import { TransportError, isRetryable } from './transport.js';

const key = () => crypto.getRandomValues(new Uint8Array(32));

describe('SealedStore', () => {
  it('never writes values in the clear and binds them to their record name', async () => {
    const kv = new MemoryKeyValueStore();
    const store = new SealedStore(kv, rawKeySealer(key()));
    await store.setJson('msgs:c:1', [{ text: 'very private words' }]);
    expect(await store.getJson('msgs:c:1')).toEqual([{ text: 'very private words' }]);
    for (const raw of kv.rawValues())
      expect(new TextDecoder().decode(raw)).not.toContain('private');
    // Moving a sealed value to another key is detected.
    const sealed = await kv.get('msgs:c:1');
    await kv.set('msgs:c:2', sealed ?? new Uint8Array());
    await expect(store.getJson('msgs:c:2')).rejects.toThrow();
  });

  it('cannot be read with another device’s key', async () => {
    const kv = new MemoryKeyValueStore();
    await new SealedStore(kv, rawKeySealer(key())).setJson('identity', { privateKey: 'x' });
    await expect(new SealedStore(kv, rawKeySealer(key())).getJson('identity')).rejects.toThrow();
  });
});

describe('KeyedLock', () => {
  it('runs tasks for the same key one at a time, in order, even when some fail', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const slow = (name: string, ms: number, fail = false) =>
      lock.run('conversation', async () => {
        order.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end ${name}`);
        if (fail) throw new Error(name);
      });
    await Promise.allSettled([slow('a', 20, true), slow('b', 1), slow('c', 1)]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('runs different keys concurrently', async () => {
    const lock = new KeyedLock();
    let concurrent = 0;
    let peak = 0;
    const task = () => async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
    };
    await Promise.all([lock.run('a', task()), lock.run('b', task())]);
    expect(peak).toBe(2);
  });
});

describe('payloads', () => {
  it('round-trips valid payloads and rejects anything else', () => {
    const payload = { v: 1 as const, text: 'Hello <b>not html</b>' };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
    expect(decodePayload(utf8('{"v":1,"text":"hi","script":"alert(1)"}'))).toBeUndefined();
    expect(decodePayload(utf8('not json'))).toBeUndefined();
    expect(decodePayload(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(() => encodePayload({ v: 1 } as never)).toThrow();
  });

  it('recognises real raster images only (never SVG or HTML)', () => {
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(detectImageMime(utf8('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(detectImageMime(utf8('<html><script>'))).toBeUndefined();
  });

  it('normalises text for search', () => {
    expect(searchable('ＣＡＦÉ')).toBe(searchable('café'));
  });
});

describe('message status', () => {
  const base: LocalMessage = {
    id: 'm',
    clientMessageId: 'c',
    conversationId: 'x',
    seq: 5,
    version: 5,
    senderOgcId: 'OGC482731905',
    senderDeviceKeyId: null,
    mine: true,
    state: 'ok',
    payload: null,
    replyToId: null,
    forwarded: false,
    revision: 0,
    editedAt: null,
    createdAt: '',
    reactions: [],
    attachmentIds: [],
  };

  it('derives PENDING → SENT → DELIVERED → READ from high-water marks', () => {
    expect(messageStatus({ ...base, state: 'pending', seq: null }, undefined)).toBe('PENDING');
    expect(messageStatus(base, { peerLastDeliveredSeq: 4, peerLastReadSeq: 0 })).toBe('SENT');
    expect(messageStatus(base, { peerLastDeliveredSeq: 5, peerLastReadSeq: 0 })).toBe('DELIVERED');
    expect(messageStatus(base, { peerLastDeliveredSeq: 9, peerLastReadSeq: 7 })).toBe('READ');
    expect(messageStatus({ ...base, state: 'failed' }, undefined)).toBe('FAILED');
    expect(messageStatus({ ...base, mine: false }, undefined)).toBeUndefined();
  });
});

describe('transport errors', () => {
  it('treats network failures, rate limits and server errors as retryable', () => {
    expect(isRetryable(new TransportError('offline', 0))).toBe(true);
    expect(isRetryable(new TransportError('slow down', 429, 'RATE_LIMITED'))).toBe(true);
    expect(isRetryable(new TransportError('boom', 503))).toBe(true);
    expect(isRetryable(new TransportError('bad', 400, 'VALIDATION_FAILED'))).toBe(false);
    expect(isRetryable(new Error('other'))).toBe(false);
  });
});

describe('group display helpers', () => {
  const base = {
    id: 'c1',
    version: 1,
    lastActivityAt: '2026-10-13T00:00:00.000Z',
    lastMessage: null,
    unreadCount: 0,
    myLastReadSeq: 0,
    peerLastReadSeq: 0,
    peerLastDeliveredSeq: 0,
    blockedByMe: false,
    mls: { epoch: 1, ready: true },
    createdAt: '2026-10-13T00:00:00.000Z',
  };

  it('titles groups by name and direct conversations by the other person', () => {
    const group = {
      ...base,
      type: 'GROUP' as const,
      peer: null,
      group: {
        kind: 'GROUP' as const,
        name: 'Rowing club',
        description: null,
        avatarUrl: '/g.webp',
        myRole: 'MEMBER' as const,
        memberCount: 3,
        postPolicy: 'ALL_MEMBERS' as const,
        invitePolicy: 'ADMINS' as const,
        archived: false,
        canPost: true,
      },
    };
    expect(conversationTitle(group)).toBe('Rowing club');
    expect(conversationAvatar(group)).toEqual({ url: '/g.webp', name: 'Rowing club' });
    const direct = {
      ...base,
      type: 'DIRECT' as const,
      group: null,
      peer: { ogcId: 'OGC482731905' as never, displayName: 'Ada', avatarUrl: null },
    };
    expect(conversationTitle(direct)).toBe('Ada');
  });

  it('finds mentions by @name or OGC ID only among members', () => {
    const members = [
      { ogcId: 'OGC482731905', displayName: 'Ada Lovelace' },
      { ogcId: 'OGC111222333', displayName: 'Grace' },
    ];
    expect(mentionsIn('Thanks @ada lovelace!', members)).toEqual(['OGC482731905']);
    expect(mentionsIn('ping ogc111222333', members)).toEqual(['OGC111222333']);
    expect(mentionsIn('Grace without the at-sign', members)).toEqual([]);
  });
});

describe('timeline events', () => {
  const names: Record<string, string> = { A: 'Ada', G: 'Grace' };
  const nameOf = (id: string | null) => (id ? (names[id] ?? id) : 'Someone');

  it('describes membership and role changes without content', () => {
    expect(
      describeEvent(
        { type: 'MEMBER_REMOVED', actor: 'A' as never, subject: 'G' as never, detail: null },
        nameOf,
      ),
    ).toBe('Ada removed Grace');
    expect(
      describeEvent(
        {
          type: 'ROLE_CHANGED',
          actor: 'A' as never,
          subject: 'G' as never,
          detail: { role: 'ADMIN' },
        },
        nameOf,
      ),
    ).toBe('Ada made Grace an admin');
    expect(
      describeEvent(
        { type: 'CREATED', actor: 'A' as never, subject: null, detail: null },
        nameOf,
        'CHANNEL',
      ),
    ).toBe('Ada created the channel');
  });
});
