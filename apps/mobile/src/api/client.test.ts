import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId } from '@ogc/types';
import type { TokenStore } from '../auth/token-store';
import { ApiClient } from './client';

const account: AccountView = {
  ogcId: 'OGC306841127' as OgcId,
  displayName: 'Ada',
  email: 'ada@example.test',
  emailVerified: true,
  accountStatus: 'ACTIVE',
  createdAt: '2026-10-12T10:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const authResponse = (n: number) => ({
  account,
  session: {},
  tokens: { accessToken: `ogc_at_access${n}`, refreshToken: `ogc_rt_refresh${n}` },
});

function memoryStore(initial: string | null = null) {
  let value = initial;
  const setRefreshToken = jest.fn((token: string) => {
    value = token;
    return Promise.resolve();
  });
  const store: TokenStore = {
    getRefreshToken: () => Promise.resolve(value),
    setRefreshToken,
    clear: () => {
      value = null;
      return Promise.resolve();
    },
  };
  return { store, setRefreshToken, current: () => value };
}

type Route = (init: RequestInit) => Response;

function client(routes: Record<string, Route>, store: TokenStore) {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init.method ?? 'GET'} ${url.replace('https://api.test', '')}`;
    calls.push({ key, init });
    const route = routes[key];
    return route ? Promise.resolve(route(init)) : Promise.reject(new Error(`Unexpected ${key}`));
  }) as unknown as typeof fetch;
  return {
    api: new ApiClient({ baseUrl: 'https://api.test', platform: 'IOS', store, fetchImpl }),
    calls,
  };
}

const headersOf = (init: RequestInit | undefined) =>
  (init?.headers ?? {}) as Record<string, string>;

describe('ApiClient (native)', () => {
  let mem: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    mem = memoryStore();
  });

  it('logs in with a device descriptor and keeps only the refresh token in secure storage', async () => {
    const { api, calls } = client(
      { 'POST /v1/auth/login': () => json(authResponse(1)) },
      mem.store,
    );
    await expect(api.login('ada@example.test', 'pw')).resolves.toEqual(account);

    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      email: 'ada@example.test',
      password: 'pw',
      device: { platform: 'IOS' },
    });
    // Native clients never use browser cookie mode.
    expect(headersOf(calls[0]?.init)['x-ogc-client']).toBeUndefined();
    expect(mem.current()).toBe('ogc_rt_refresh1');
    expect(mem.setRefreshToken).toHaveBeenCalledTimes(1);
    expect(mem.setRefreshToken).not.toHaveBeenCalledWith('ogc_at_access1');
  });

  it('sends the in-memory access token as a bearer token', async () => {
    const { api, calls } = client(
      {
        'POST /v1/auth/login': () => json(authResponse(1)),
        'GET /v1/auth/me': () => json(account),
      },
      mem.store,
    );
    await api.login('ada@example.test', 'pw');
    await api.me();
    expect(headersOf(calls[1]?.init).Authorization).toBe('Bearer ogc_at_access1');
  });

  it('refreshes on 401, rotates the stored refresh token, and retries', async () => {
    let meCalls = 0;
    const { api, calls } = client(
      {
        'POST /v1/auth/login': () => json(authResponse(1)),
        'GET /v1/auth/me': () =>
          meCalls++ === 0 ? json({ code: 'UNAUTHENTICATED' }, 401) : json(account),
        'POST /v1/auth/refresh': () => json(authResponse(2)),
      },
      mem.store,
    );
    await api.login('ada@example.test', 'pw');
    await expect(api.me()).resolves.toEqual(account);
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({ refreshToken: 'ogc_rt_refresh1' });
    expect(headersOf(calls[3]?.init).Authorization).toBe('Bearer ogc_at_access2');
    expect(mem.current()).toBe('ogc_rt_refresh2');
  });

  it('restores a session from secure storage after a restart', async () => {
    const restored = memoryStore('ogc_rt_saved');
    const { api } = client(
      {
        'POST /v1/auth/refresh': () => json(authResponse(3)),
        'GET /v1/auth/me': () => json(account),
      },
      restored.store,
    );
    await expect(api.restore()).resolves.toEqual(account);
    expect(restored.current()).toBe('ogc_rt_refresh3');
  });

  it('forgets credentials when the server rejects the refresh token', async () => {
    const restored = memoryStore('ogc_rt_revoked');
    const { api } = client(
      { 'POST /v1/auth/refresh': () => json({ code: 'UNAUTHENTICATED' }, 401) },
      restored.store,
    );
    await expect(api.restore()).resolves.toBeUndefined();
    expect(restored.current()).toBeNull();
  });

  it('keeps the session on network errors during refresh', async () => {
    const restored = memoryStore('ogc_rt_saved');
    const { api } = client({}, restored.store);
    await expect(api.restore()).resolves.toBeUndefined();
    expect(restored.current()).toBe('ogc_rt_saved');
  });

  it('revokes the session server-side and clears secure storage on logout', async () => {
    const { api, calls } = client(
      {
        'POST /v1/auth/login': () => json(authResponse(1)),
        'POST /v1/auth/logout': () => json(null, 204),
      },
      mem.store,
    );
    await api.login('ada@example.test', 'pw');
    await api.logout();
    expect(calls.map((c) => c.key)).toContain('POST /v1/auth/logout');
    expect(mem.current()).toBeNull();
  });
});
