import type { AccountView, OgcId, OwnProfile, PublicProfile } from '@ogc/types';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import type { MessagingDependencies } from '../messaging/messaging-context';
import { MessagingProvider } from '../messaging/MessagingProvider';
import { inertMessaging } from './fake-messaging';

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

export function renderApp(path: string, messaging: MessagingDependencies = inertMessaging) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <MessagingProvider dependencies={messaging}>
          <App />
        </MessagingProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

export function ownProfile(overrides: Partial<OwnProfile> = {}): OwnProfile {
  return {
    ogcId: 'OGC306841127' as OgcId,
    displayName: 'Ada Lovelace',
    bio: null,
    avatarUrl: null,
    memberSince: '2026-10-12T10:00:00.000Z',
    privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
    ...overrides,
  };
}

export function publicProfile(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    ogcId: 'OGC482731905' as OgcId,
    displayName: 'Grace Hopper',
    bio: null,
    avatarUrl: null,
    memberSince: null,
    relationship: 'NONE',
    canSendContactRequest: true,
    pendingRequestId: null,
    ...overrides,
  };
}

export const emptyPage = { items: [], nextCursor: null };

/** Routes for a signed-in ACTIVE user with an own profile. */
export function signedInRoutes(profile: OwnProfile = ownProfile()): Record<string, Handler> {
  return {
    'GET /api/v1/auth/me': () =>
      json(account({ ogcId: profile.ogcId, displayName: profile.displayName })),
    'GET /api/v1/profile': () => json(profile),
  };
}
