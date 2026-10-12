import { afterEach, describe, expect, it, vi } from 'vitest';
import { account, json, mockApi, unauthenticated } from '../test/helpers';
import { ApiError, api } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client (browser mode)', () => {
  it('identifies as the web client and never sends bearer tokens', async () => {
    const fetchMock = mockApi({ 'GET /api/v1/auth/me': () => json(account()) });
    await api.me();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-ogc-client']).toBe('web');
    expect(headers).not.toHaveProperty('Authorization');
    expect(init?.credentials).toBe('same-origin');
  });

  it('refreshes once and retries when the access cookie has expired', async () => {
    let calls = 0;
    const fetchMock = mockApi({
      'GET /api/v1/auth/me': () => (calls++ === 0 ? unauthenticated() : json(account())),
      'POST /api/v1/auth/refresh': () => json({ account: account(), session: {} }),
    });
    await expect(api.me()).resolves.toMatchObject({ ogcId: 'OGC306841127' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/me',
      '/api/v1/auth/refresh',
      '/api/v1/auth/me',
    ]);
  });

  it('shares one refresh between concurrent requests (avoids refresh-token reuse)', async () => {
    let meCalls = 0;
    const fetchMock = mockApi({
      // The first two (concurrent) requests find the access cookie expired.
      'GET /api/v1/auth/me': () => (++meCalls <= 2 ? unauthenticated() : json(account())),
      'POST /api/v1/auth/refresh': async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json({ account: account(), session: {} });
      },
    });
    await Promise.all([api.me(), api.me()]);
    const refreshes = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/refresh');
    expect(refreshes).toHaveLength(1);
    expect(meCalls).toBe(4);
  });

  it('does not loop when the refresh itself fails', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/auth/me': () => unauthenticated(),
      'POST /api/v1/auth/refresh': () => unauthenticated(),
    });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces API error codes', async () => {
    mockApi({
      'POST /api/v1/auth/login': () =>
        json(
          {
            statusCode: 401,
            error: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            code: 'INVALID_CREDENTIALS',
          },
          401,
        ),
    });
    const error = await api.login({ email: 'a@b.test', password: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
  });
});
