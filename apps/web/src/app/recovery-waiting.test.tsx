import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, conversationView, fakeMessaging } from '../test/fake-messaging';
import { mockApi, renderApp, signedInRoutes } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WAITING = conversationView();
const OTHER = conversationView({ id: 'c0ffee00-0000-4000-8000-0000000000bb' });

function open(conversationId: string, engine: FakeEngine) {
  mockApi(signedInRoutes());
  renderApp(`/messages/${conversationId}`, fakeMessaging(engine).dependencies);
}

const status = () => screen.queryByRole('status', { name: 'Encryption waiting' });

describe('encryption waiting for another device', () => {
  it('explains that pending messages have not been sent, in the affected conversation', async () => {
    const engine = new FakeEngine([WAITING, OTHER]);
    engine.waitingForDevice.add(WAITING.id);
    open(WAITING.id, engine);
    await waitFor(() => {
      expect(status()?.textContent).toBe(
        'Encryption is waiting for another device to join this conversation. Your pending messages haven’t been sent yet.',
      );
    });
    expect(engine.awaitingAnotherDevice).toHaveBeenCalledWith(WAITING.id);
    // No library, cryptographic or device detail reaches the person.
    expect(status()?.textContent).not.toMatch(/ts-mls|leaf|MLS|epoch|[0-9a-f]{8}-/i);
  });

  it('is not shown in other conversations', async () => {
    const engine = new FakeEngine([WAITING, OTHER]);
    engine.waitingForDevice.add(WAITING.id);
    open(OTHER.id, engine);
    await screen.findByRole('region', { name: /Conversation with/ });
    expect(status()).toBeNull();
  });

  it('clears when recovery resolves', async () => {
    const engine = new FakeEngine([WAITING]);
    engine.waitingForDevice.add(WAITING.id);
    open(WAITING.id, engine);
    await waitFor(() => {
      expect(status()).not.toBeNull();
    });
    act(() => {
      engine.waitingForDevice.delete(WAITING.id);
      engine.emit({ type: 'recovery', conversationId: WAITING.id });
    });
    await waitFor(() => {
      expect(status()).toBeNull();
    });
  });
});
