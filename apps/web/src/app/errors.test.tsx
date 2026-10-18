import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canEncryptHere, INSECURE_CONTEXT_ERROR } from '../messaging/secure-context';
import { FakeEngine, conversationView, fakeMessaging } from '../test/fake-messaging';
import {
  account,
  json,
  mockApi,
  renderApp,
  signedInRoutes,
  unauthenticated,
} from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedOut = {
  'GET /api/v1/auth/me': unauthenticated,
  'POST /api/v1/auth/refresh': unauthenticated,
};
const ZERO = '00000000-0000-4000-8000-000000000000';

/** The channel page loads the channel, its posts and its pins together; all answer alike. */
function channelAnswers(status: 404 | 403) {
  const error = status === 404 ? 'NOT_FOUND' : 'FORBIDDEN';
  const answer = () => json({ statusCode: status, error, message: 'x', code: error }, status);
  return {
    [`GET /api/v1/channels/${ZERO}`]: answer,
    [`GET /api/v1/channels/${ZERO}/posts`]: answer,
    [`GET /api/v1/channels/${ZERO}/pinned`]: answer,
  };
}

describe('unknown web addresses (404)', () => {
  it('shows a branded page inside the app when signed in, with a way home', async () => {
    mockApi(signedInRoutes());
    renderApp('/no/such/page');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Page not found' });
    expect(heading).toBeTruthy();
    // Exactly one level-1 heading (the shell's page title, kept for screen readers).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('/no/such/page')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/home');
    // Still inside the app: the main navigation is available.
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0);
    // Opened directly (no earlier page in this tab): no "Go back".
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull();
  });

  it('offers "Go back" when there is an earlier page, and it works', async () => {
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/contacts': () => json({ items: [], nextCursor: null }),
    });
    renderApp('/contactz', undefined, ['/contacts']);
    await screen.findByRole('heading', { level: 2, name: 'Page not found' });
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeTruthy();
  });

  it('shows the public layout to visitors and never sends them into member pages', async () => {
    mockApi(signedOut);
    renderApp('/settings/does-not-exist');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    const way = screen.getByRole('link', { name: 'Go to the welcome page' });
    expect(way.getAttribute('href')).toBe('/');
    expect(screen.queryByRole('link', { name: 'Go to Home' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('sends unverified accounts towards verification, not into the app', async () => {
    mockApi({
      'GET /api/v1/auth/me': () =>
        json(account({ accountStatus: 'PENDING_VERIFICATION', emailVerified: false })),
    });
    renderApp('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Finish verifying your email' }).getAttribute('href'),
    ).toBe('/verify');
  });

  it('keeps member pages behind sign-in (refreshing a nested route still checks the session)', async () => {
    mockApi(signedOut);
    renderApp('/settings/security');
    expect(await screen.findByRole('heading', { name: 'Sign in to OGC' })).toBeTruthy();
  });
});

describe('unavailable and forbidden resources', () => {
  it('explains a conversation that is not available, with a way back', async () => {
    mockApi(signedInRoutes());
    renderApp(
      `/messages/${ZERO}`,
      fakeMessaging(new FakeEngine([conversationView()])).dependencies,
    );
    expect(await screen.findByRole('heading', { name: 'Conversation not available' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to conversations' }).getAttribute('href')).toBe(
      '/messages',
    );
  });

  it('shows "not available" for a missing channel and "no access" for a forbidden one', async () => {
    mockApi({ ...signedInRoutes(), ...channelAnswers(404) });
    renderApp(`/channels/${ZERO}`);
    expect(await screen.findByRole('heading', { name: 'Channel not available' })).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    mockApi({ ...signedInRoutes(), ...channelAnswers(403) });
    renderApp(`/channels/${ZERO}`);
    const denied = await screen.findByRole('heading', {
      name: 'You don’t have access to this channel',
    });
    const state = denied.closest('section');
    if (!(state instanceof HTMLElement)) throw new Error('error state section missing');
    expect(within(state).getByText('403')).toBeTruthy();
    expect(within(state).getByRole('link', { name: 'Back to channels' }).getAttribute('href')).toBe(
      '/channels',
    );
  });

  it('explains a profile that is not available without saying whether it exists', async () => {
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/profiles/OGC000000000': () =>
        json({ statusCode: 404, error: 'NOT_FOUND', message: 'x' }, 404),
    });
    renderApp('/id/OGC000000000');
    expect(await screen.findByRole('heading', { name: 'Profile not available' })).toBeTruthy();
    expect(screen.getByText(/may not be visible to you/)).toBeTruthy();
  });
});

describe('insecure pages (plain HTTP at a network address)', () => {
  it('detects a missing Web Crypto API or an insecure context', () => {
    expect(canEncryptHere({ isSecureContext: true, crypto: { subtle: {} } })).toBe(true);
    expect(canEncryptHere({ isSecureContext: false, crypto: { subtle: {} } })).toBe(false);
    expect(canEncryptHere({ isSecureContext: true, crypto: {} })).toBe(false);
  });

  it('says why secure messaging is unavailable instead of showing an empty list', async () => {
    vi.stubGlobal('isSecureContext', false);
    mockApi(signedInRoutes());
    renderApp('/messages', fakeMessaging(new FakeEngine([])).dependencies);
    const region = await screen.findByRole('region', { name: 'Conversations' });
    expect(await within(region).findByText(INSECURE_CONTEXT_ERROR)).toBeTruthy();
    // Retrying cannot help on an insecure page, so it is not offered.
    expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
