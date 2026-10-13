import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  account,
  bodyOf,
  json,
  mockApi,
  ownProfile,
  renderApp,
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

function fill(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('welcome', () => {
  it('invites visitors to create an OGC ID or sign in', async () => {
    mockApi(signedOut);
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveProperty(
      'textContent',
      'Your identity.Not your phone number.',
    );
    expect(screen.getByRole('link', { name: 'Create your OGC ID' }).getAttribute('href')).toBe(
      '/register',
    );
  });

  it('sends signed-out visitors away from protected pages', async () => {
    mockApi(signedOut);
    renderApp('/home');
    expect(await screen.findByRole('heading', { name: 'Sign in to OGC' })).toBeTruthy();
  });
});

describe('sign in', () => {
  it('validates input before calling the API', async () => {
    const fetchMock = mockApi(signedOut);
    renderApp('/login');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/auth/login')).toBe(false);
  });

  it('shows a generic message for wrong credentials and clears the password', async () => {
    mockApi({
      ...signedOut,
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
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in to OGC' });
    fill('Email', 'ada@example.test');
    fill('Password', 'wrong password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That email and password combination is not correct.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });

  it('opens the OGC ID home with a QR code that holds only the public identity link', async () => {
    const fetchMock = mockApi({
      ...signedOut,
      'POST /api/v1/auth/login': () => json({ account: account(), session: {} }),
      'GET /api/v1/profile': () => json(ownProfile()),
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in to OGC' });
    fill('Email', 'Ada@Example.test');
    fill('Password', 'correct horse battery staple');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Your OGC ID' })).toBeTruthy();
    expect(screen.getByText('OGC 306 841 127')).toBeTruthy();
    const qr = screen.getByRole('img', { name: 'QR code for OGC306841127' });
    expect(qr.closest('figure')?.getAttribute('data-payload')).toBe('ogc://id/OGC306841127');
    expect(screen.getByRole('button', { name: 'Share my OGC' })).toBeTruthy();

    const login = fetchMock.mock.calls.find(([url]) => url === '/api/v1/auth/login');
    expect(bodyOf(login?.[1])).toEqual({
      email: 'Ada@Example.test',
      password: 'correct horse battery staple',
    });
  });

  it('sends unverified accounts to the verification screen', async () => {
    mockApi({
      ...signedOut,
      'POST /api/v1/auth/login': () =>
        json({
          account: account({ accountStatus: 'PENDING_VERIFICATION', emailVerified: false }),
          session: {},
        }),
      'POST /api/v1/auth/verify-email/resend': () =>
        json({ message: 'A new link is on its way.' }, 202),
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in to OGC' });
    fill('Email', 'ada@example.test');
    fill('Password', 'correct horse battery staple');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Verify your email' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(await screen.findByText('A new link is on its way.')).toBeTruthy();
  });
});

describe('create account', () => {
  it('explains password requirements without calling the API', async () => {
    const fetchMock = mockApi(signedOut);
    renderApp('/register');
    await screen.findByRole('heading', { name: 'Create your OGC account' });
    fill('Display name', 'Ada');
    fill('Email', 'ada@example.test');
    fill('Password', 'too short');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 12 characters')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/auth/register')).toBe(false);
  });

  it('registers and asks the user to check their email', async () => {
    mockApi({
      ...signedOut,
      'POST /api/v1/auth/register': () =>
        json({ verificationRequired: true, message: 'Check your email.' }, 202),
    });
    renderApp('/register');
    await screen.findByRole('heading', { name: 'Create your OGC account' });
    fill('Display name', 'Ada Lovelace');
    fill('Email', 'Ada@Example.test');
    fill('Password', 'correct horse battery staple');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(screen.getByText('ada@example.test')).toBeTruthy();
  });
});

describe('email verification link', () => {
  const token = 'A'.repeat(43);

  it('submits the token from the URL fragment exactly once', async () => {
    const fetchMock = mockApi({
      ...signedOut,
      'POST /api/v1/auth/verify-email': () => json({ verified: true }),
    });
    renderApp(`/verify-email#token=${token}`);
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeTruthy();
    const calls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/verify-email');
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]?.[1])).toEqual({ token });
  });

  it('reports an invalid or expired link', async () => {
    mockApi({
      ...signedOut,
      'POST /api/v1/auth/verify-email': () =>
        json(
          {
            statusCode: 400,
            error: 'BAD_REQUEST',
            message: 'x',
            code: 'INVALID_VERIFICATION_TOKEN',
          },
          400,
        ),
    });
    renderApp(`/verify-email#token=${token}`);
    expect(await screen.findByRole('heading', { name: 'Verification failed' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'This verification link is invalid or has expired.',
    );
  });

  it('rejects a malformed link without calling the API', async () => {
    const fetchMock = mockApi(signedOut);
    renderApp('/verify-email#token=short');
    expect(await screen.findByRole('heading', { name: 'Verification failed' })).toBeTruthy();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/auth/verify-email')).toBe(false);
    });
  });
});

describe('signed-in home', () => {
  it('signs out', async () => {
    let signedIn = true;
    mockApi({
      'GET /api/v1/auth/me': () => (signedIn ? json(account()) : unauthenticated()),
      'GET /api/v1/profile': () => json(ownProfile()),
      'POST /api/v1/auth/refresh': unauthenticated,
      'POST /api/v1/auth/logout': () => {
        signedIn = false;
        return json(null, 204);
      },
    });
    renderApp('/home');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to OGC' })).toBeTruthy();
  });

  it('keeps every destination reachable from the phone tab bar', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => json(account()),
      'GET /api/v1/profile': () => json(ownProfile()),
    });
    renderApp('/home');
    const [, tabBar] = await screen.findAllByRole('navigation', { name: 'Main' });
    const tabs = within(required(tabBar));
    for (const name of ['Messages', 'Channels', 'Alerts', 'Contacts']) {
      expect(tabs.getByRole('link', { name })).toBeTruthy();
    }
    const more = tabs.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(tabs.queryByRole('link', { name: 'Discover' })).toBeNull();

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    for (const name of ['My OGC', 'Discover', 'Privacy']) {
      expect(tabs.getByRole('link', { name })).toBeTruthy();
    }
    expect(tabs.getByRole('button', { name: 'Sign out' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(tabs.queryByRole('link', { name: 'Discover' })).toBeNull();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected element');
  return value;
}
