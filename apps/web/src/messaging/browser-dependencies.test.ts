import { describe, expect, it, vi } from 'vitest';

const created: unknown[] = [];
vi.mock('@ogc/messaging', () => ({
  MessagingClient: vi.fn(),
  SealedStore: vi.fn(),
  RealtimeConnection: vi.fn(function RealtimeConnection(options: unknown) {
    created.push(options);
  }),
}));

const { browserDependencies } = await import('./browser-dependencies');

describe('browser realtime wiring', () => {
  it('connects same-origin over WebSocket only, authenticated by the session cookie', () => {
    browserDependencies.createRealtime({}, vi.fn(), vi.fn());
    // Browsers omit Origin on a same-origin long-polling GET, and the server requires an
    // allowlisted Origin for cookie sessions: a polling handshake would always be refused.
    expect(created).toEqual([{ origin: '', transports: ['websocket'] }]);
  });
});
