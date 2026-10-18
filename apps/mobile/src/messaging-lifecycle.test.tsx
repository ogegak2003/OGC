import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId, OwnProfile } from '@ogc/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import type { MessagingDependencies } from './messaging/messaging-context';
import { FakeEngine, fakeMessaging } from './test/fake-messaging';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

const account: AccountView = {
  ogcId: 'OGC306841127' as OgcId,
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  emailVerified: true,
  accountStatus: 'ACTIVE',
  createdAt: '2026-10-12T10:00:00.000Z',
};

const ownProfile: OwnProfile = {
  ogcId: account.ogcId,
  displayName: 'Ada Lovelace',
  bio: null,
  avatarUrl: null,
  memberSince: account.createdAt,
  privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
};

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const store: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function client(extra: Record<string, () => Response> = {}) {
  const routes: Record<string, () => Response> = {
    'POST /v1/auth/refresh': () =>
      json({
        account,
        session: {},
        tokens: { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_next' },
      }),
    'GET /v1/auth/me': () => json(account),
    'GET /v1/profile': () => json(ownProfile),
    ...extra,
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

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

const live = (engines: FakeEngine[]) => engines.filter((e) => e.dispose.mock.calls.length === 0);

describe('mobile: messaging engine lifecycle', () => {
  it('disposes the engine once when the app unmounts', async () => {
    const { engines, dependencies } = freshEngines();
    const view = await render(<App client={client()} messaging={dependencies} />);
    await fireEvent.press(await screen.findByRole('tab', { name: /^Chats/ }));
    await waitFor(() => {
      expect(engines).toHaveLength(1);
    });
    expect(engines[0]?.dispose).not.toHaveBeenCalled();
    await view.unmount();
    expect(engines[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a replaced engine and keeps exactly one live engine', async () => {
    const first = freshEngines();
    const second = freshEngines();
    const api = client();
    const view = await render(<App client={api} messaging={first.dependencies} />);
    await fireEvent.press(await screen.findByRole('tab', { name: /^Chats/ }));
    await waitFor(() => {
      expect(live([...first.engines, ...second.engines])).toHaveLength(1);
    });
    await view.rerender(<App client={api} messaging={second.dependencies} />);
    await waitFor(() => {
      expect(second.engines.length).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(live([...first.engines, ...second.engines])).toHaveLength(1);
    });
    expect(second.engines).toContain(live([...first.engines, ...second.engines])[0]);
    for (const engine of first.engines) expect(engine.dispose).toHaveBeenCalledTimes(1);
    await view.unmount();
    for (const engine of [...first.engines, ...second.engines]) {
      expect(engine.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('disposes an engine whose creation finishes after the app unmounted', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engines, dependencies } = freshEngines(hold);
    const view = await render(<App client={client()} messaging={dependencies} />);
    await waitFor(() => {
      expect(engines).toHaveLength(1);
    });
    await view.unmount();
    release();
    await waitFor(() => {
      expect(engines[0]?.dispose).toHaveBeenCalledTimes(1);
    });
    expect(engines[0]?.start).not.toHaveBeenCalled();
  });
});
