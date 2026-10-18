import { rawKeySealer } from '@ogc/e2ee';
import { describe, expect, it } from 'vitest';
import { EngineDisposedError, MessagingClient } from './client.js';
import type { LocalMessage } from './payload.js';
import { MemoryKeyValueStore, SealedStore } from './store.js';
import type { MessagingTransport } from './transport.js';

const CONV = '0d4c9f5e-8a5b-4c1e-9a7d-3f2b1c0e9d8a';

/** A transport that records every call and never answers (nothing should reach it). */
function recordingTransport(): { transport: MessagingTransport; calls: string[] } {
  const calls: string[] = [];
  const transport = new Proxy({} as MessagingTransport, {
    get: (_target, property) => (): Promise<never> => {
      calls.push(String(property));
      return Promise.reject(new Error(`unexpected call: ${String(property)}`));
    },
  });
  return { transport, calls };
}

const queued = (text: string): LocalMessage => ({
  id: null,
  clientMessageId: crypto.randomUUID(),
  conversationId: CONV,
  seq: null,
  version: 0,
  senderOgcId: 'OGC111111111',
  senderDeviceKeyId: null,
  mine: true,
  state: 'pending',
  payload: { v: 1, text },
  replyToId: null,
  forwarded: false,
  revision: 0,
  editedAt: null,
  createdAt: new Date().toISOString(),
  reactions: [],
  attachmentIds: [],
});

async function engineWithQueue() {
  const store = new SealedStore(
    new MemoryKeyValueStore(),
    rawKeySealer(crypto.getRandomValues(new Uint8Array(32))),
  );
  await store.setJson(`pending:${CONV}`, [queued('one'), queued('two')]);
  const { transport, calls } = recordingTransport();
  const client = new MessagingClient(transport, store, 'OGC111111111');
  return { store, client, calls };
}

describe('MessagingClient.dispose', () => {
  it('is idempotent', async () => {
    const { client } = await engineWithQueue();
    expect(client.isDisposed).toBe(false);
    client.dispose();
    client.dispose();
    expect(client.isDisposed).toBe(true);
  });

  it('makes no request, flush, sync or realtime work afterwards', async () => {
    const { client, calls } = await engineWithQueue();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    client.dispose();

    expect(await client.flushOutbox()).toBe(0);
    await client.scheduleSync(CONV);
    client.handleRealtime('mls.commit', { conversationId: CONV, epoch: 2, version: 2 });
    client.handleRealtime('devices.changed', { conversationId: CONV });
    await expect(client.send(CONV, { text: 'after' })).rejects.toBeInstanceOf(EngineDisposedError);
    // Never started here, so this fails before any request; either way nothing is sent.
    await expect(client.replenishKeyPackages()).rejects.toThrow();
    // Give any scheduled microtask work a chance to run.
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps the sealed queue intact for the next engine', async () => {
    const { store, client } = await engineWithQueue();
    client.dispose();
    await expect(client.send(CONV, { text: 'not persisted' })).rejects.toBeInstanceOf(
      EngineDisposedError,
    );
    const next = new MessagingClient(recordingTransport().transport, store, 'OGC111111111');
    expect((await next.messages(CONV)).map((m) => `${m.payload?.text ?? ''}:${m.state}`)).toEqual([
      'one:pending',
      'two:pending',
    ]);
  });
});
