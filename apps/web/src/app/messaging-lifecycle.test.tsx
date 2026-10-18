import { cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { MessagingProvider } from '../messaging/MessagingProvider';
import type { MessagingDependencies } from '../messaging/messaging-context';
import { FakeEngine, fakeMessaging } from '../test/fake-messaging';
import { mockApi, signedInRoutes } from '../test/helpers';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Dependencies whose factory creates a new engine per call (like production does). */
function freshEngines(hold?: Promise<void>) {
  const engines: FakeEngine[] = [];
  const dependencies: MessagingDependencies = {
    ...fakeMessaging().dependencies,
    createEngine: async () => {
      const engine = new FakeEngine();
      engines.push(engine);
      if (hold) await hold;
      return engine;
    },
  };
  return { engines, dependencies };
}

function mount(dependencies: MessagingDependencies) {
  mockApi(signedInRoutes());
  return render(
    <MemoryRouter initialEntries={['/messages']}>
      <AuthProvider>
        <MessagingProvider dependencies={dependencies}>
          <App />
        </MessagingProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('messaging engine lifecycle', () => {
  it('disposes the engine once when the provider unmounts', async () => {
    const { engines, dependencies } = freshEngines();
    const view = mount(dependencies);
    // The page can render before messaging has started: wait for the engine itself.
    await waitFor(() => {
      expect(engines[0]?.start).toHaveBeenCalled();
    });
    expect(engines).toHaveLength(1);
    expect(engines[0]?.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(engines[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a replaced engine and keeps exactly one live engine (also under Strict Mode)', async () => {
    const first = freshEngines();
    mockApi(signedInRoutes());
    const tree = (dependencies: MessagingDependencies) => (
      <StrictMode>
        <MemoryRouter initialEntries={['/messages']}>
          <AuthProvider>
            <MessagingProvider dependencies={dependencies}>
              <App />
            </MessagingProvider>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>
    );
    const view = render(tree(first.dependencies));
    await waitFor(() => {
      expect(first.engines.at(-1)?.start).toHaveBeenCalled();
    });
    const live = () =>
      [...first.engines, ...second.engines].filter((e) => e.dispose.mock.calls.length === 0);
    const second = freshEngines();
    await waitFor(() => {
      expect(live()).toHaveLength(1);
    });

    // The provider is handed new dependencies: its engine is replaced.
    view.rerender(tree(second.dependencies));
    await waitFor(() => {
      expect(second.engines.length).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(live()).toHaveLength(1);
    });
    expect(second.engines).toContain(live()[0]);
    for (const engine of first.engines) expect(engine.dispose).toHaveBeenCalledTimes(1);

    view.unmount();
    for (const engine of [...first.engines, ...second.engines]) {
      expect(engine.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('disposes an engine whose creation finishes after the provider unmounted', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engines, dependencies } = freshEngines(hold);
    const view = mount(dependencies);
    await waitFor(() => {
      expect(engines).toHaveLength(1);
    });
    view.unmount(); // before the engine was handed over
    release();
    await waitFor(() => {
      expect(engines[0]?.dispose).toHaveBeenCalledTimes(1);
    });
    expect(engines[0]?.start).not.toHaveBeenCalled();
  });
});
