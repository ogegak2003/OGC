import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPresence, PRESENCE_TTL_MS } from './presence.store.js';

describe('MemoryPresence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is online while any connection lives and reports transitions once', async () => {
    const presence = new MemoryPresence();
    expect(await presence.connect({ userId: 'u', deviceId: 'd1', socketId: 's1' })).toBe(true);
    expect(await presence.connect({ userId: 'u', deviceId: 'd2', socketId: 's2' })).toBe(false);
    expect(await presence.disconnect({ userId: 'u', deviceId: 'd1', socketId: 's1' })).toBe(false);
    expect(await presence.onlineDevices(['d1', 'd2'])).toEqual(new Set(['d2']));
    expect(await presence.disconnect({ userId: 'u', deviceId: 'd2', socketId: 's2' })).toBe(true);
    expect(await presence.onlineUsers(['u'])).toEqual(new Set());
  });

  it('expires connections that stop sending heartbeats', async () => {
    vi.useFakeTimers();
    const presence = new MemoryPresence();
    await presence.connect({ userId: 'u', deviceId: 'd', socketId: 's' });
    vi.advanceTimersByTime(PRESENCE_TTL_MS - 1000);
    await presence.heartbeat([{ userId: 'u', deviceId: 'd', socketId: 's' }]);
    vi.advanceTimersByTime(PRESENCE_TTL_MS - 1000);
    expect(await presence.onlineUsers(['u'])).toEqual(new Set(['u']));
    vi.advanceTimersByTime(2000);
    expect(await presence.onlineUsers(['u'])).toEqual(new Set());
  });
});
