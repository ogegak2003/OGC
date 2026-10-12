import type { AccountView, OgcId } from '@ogc/types';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../app/App';
import { AuthProvider } from '../auth/AuthProvider';

export type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const unauthenticated = (): Response =>
  json(
    {
      statusCode: 401,
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
      code: 'UNAUTHENTICATED',
    },
    401,
  );

export function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    ogcId: 'OGC306841127' as OgcId,
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    emailVerified: true,
    accountStatus: 'ACTIVE',
    createdAt: '2026-10-12T10:00:00.000Z',
    ...overrides,
  };
}

/** Installs a fetch mock routing `METHOD /path` to handlers; unknown routes fail the test. */
export function mockApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn<typeof fetch>((input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) return Promise.reject(new Error(`Unexpected request: ${key}`));
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

export function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}
