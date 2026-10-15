import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ExpoPushProvider,
  OutboxPushProvider,
  type PushNotification,
  androidChannel,
  classifyExpoError,
} from './push-provider.js';

const notification = (
  token: string,
  provider: PushNotification['provider'] = 'EXPO',
): PushNotification => ({
  provider,
  token,
  title: 'OGC',
  body: 'New message',
  data: { type: 'message', conversationId: 'c-1' },
});

describe('ExpoPushProvider', () => {
  it('sends only Expo tokens, in batches of 100, with generic content', async () => {
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const provider = new ExpoPushProvider(
      'expo-access-token',
      fetchImpl as unknown as typeof fetch,
    );
    const many = Array.from({ length: 150 }, (_, i) =>
      notification(`ExponentPushToken[${String(i)}]`),
    );
    await provider.send([...many, notification('apns-token', 'APNS')]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as { to: string; body: string; data: unknown }[];
    expect(body).toHaveLength(100);
    expect(body[0]).toMatchObject({
      body: 'New message',
      data: { type: 'message', conversationId: 'c-1' },
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('apns-token');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer expo-access-token',
    );
  });
});

describe('OutboxPushProvider', () => {
  it('writes notifications for development without full device tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ogc-push-'));
    await new OutboxPushProvider(dir).send([notification('ExponentPushToken[abcdefghijklmnop]')]);
    const [file] = await readdir(dir);
    const written = await readFile(join(dir, file ?? ''), 'utf8');
    expect(written).toContain('New message');
    expect(written).not.toContain('abcdefghij');
  });
});

describe('Expo tickets and receipts (mocked Expo API — no real delivery)', () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );

  it('maps each ticket to a result, in order, and classifies errors', async () => {
    const fetchImpl = respond({
      data: [
        { status: 'ok', id: 'ticket-1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
        { status: 'error', message: 'bad', details: { error: 'MessageTooBig' } },
      ],
    });
    const provider = new ExpoPushProvider(undefined, fetchImpl as unknown as typeof fetch);
    const results = await provider.send([
      notification('ExponentPushToken[a]'),
      notification('ExponentPushToken[b]'),
      notification('ExponentPushToken[c]'),
      notification('ExponentPushToken[d]'),
      notification('fcm-token', 'FCM'),
    ]);
    expect(results).toEqual([
      { ok: true, ticketId: 'ticket-1' },
      { ok: false, code: 'DeviceNotRegistered', retryable: false, invalidToken: true },
      { ok: false, code: 'MessageRateExceeded', retryable: true, invalidToken: false },
      { ok: false, code: 'MessageTooBig', retryable: false, invalidToken: false },
      { ok: false, code: 'UnsupportedProvider', retryable: false, invalidToken: false },
    ]);
  });

  it('treats 429, 5xx and network failures as temporary and other 4xx as permanent', async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
    ] as const) {
      const provider = new ExpoPushProvider(
        undefined,
        respond({ errors: [] }, status) as unknown as typeof fetch,
      );
      expect(await provider.send([notification('ExponentPushToken[a]')])).toEqual([
        { ok: false, code: `HTTP_${String(status)}`, retryable, invalidToken: false },
      ]);
    }
    const offline = new ExpoPushProvider(undefined, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(await offline.send([notification('ExponentPushToken[a]')])).toEqual([
      { ok: false, code: 'NETWORK', retryable: true, invalidToken: false },
    ]);
  });

  it('sends sound, priority, channel and expiry, and nothing else', async () => {
    const fetchImpl = respond({ data: [{ status: 'ok', id: 't' }] });
    await new ExpoPushProvider(undefined, fetchImpl as unknown as typeof fetch).send([
      { ...notification('ExponentPushToken[a]'), sound: false, vibration: false, ttlSeconds: 45 },
    ]);
    const [message] = JSON.parse(fetchImpl.mock.calls[0]?.[1].body as string) as Record<
      string,
      unknown
    >[];
    expect(message).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'OGC',
      body: 'New message',
      data: { type: 'message', conversationId: 'c-1' },
      priority: 'normal',
      channelId: 'ogc-silent',
      ttl: 45,
    });
  });

  it('reads receipts and spots dead tokens', async () => {
    const fetchImpl = respond({
      data: {
        good: { status: 'ok' },
        dead: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    });
    const receipts = await new ExpoPushProvider(
      undefined,
      fetchImpl as unknown as typeof fetch,
    ).receipts(['good', 'dead']);
    expect(receipts.get('good')).toEqual({ ok: true });
    expect(receipts.get('dead')).toEqual({
      ok: false,
      code: 'DeviceNotRegistered',
      invalidToken: true,
    });
  });

  it('picks the Android channel from sound, vibration and urgency', () => {
    expect(androidChannel({})).toBe('ogc-alerts');
    expect(androidChannel({ sound: true, vibration: false })).toBe('ogc-sound');
    expect(androidChannel({ sound: false, vibration: true })).toBe('ogc-vibrate');
    expect(androidChannel({ sound: false, vibration: false, urgent: true })).toBe('ogc-silent');
    expect(androidChannel({ urgent: true })).toBe('ogc-calls');
    expect(classifyExpoError(undefined)).toEqual({
      code: 'Unknown',
      retryable: true,
      invalidToken: false,
    });
  });
});
