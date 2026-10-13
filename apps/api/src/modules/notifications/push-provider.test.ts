import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider, OutboxPushProvider, type PushNotification } from './push-provider.js';

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
