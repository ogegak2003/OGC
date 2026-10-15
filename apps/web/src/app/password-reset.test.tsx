import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, json, mockApi, renderApp, unauthenticated } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedOut = {
  'GET /api/v1/auth/me': unauthenticated,
  'POST /api/v1/auth/refresh': unauthenticated,
};
const TOKEN = `ogc_pr_${'Q'.repeat(43)}`;
const GENERIC =
  'If an account uses this email address, a link to reset its password is on its way. It expires soon and can be used once.';

describe('forgot password (web)', () => {
  it('is linked from sign-in and shows the same answer for any address', async () => {
    const forgot = vi.fn(() => json({ message: GENERIC }, 202));
    const fetchMock = mockApi({ ...signedOut, 'POST /api/v1/auth/password/forgot': forgot });
    renderApp('/login');
    fireEvent.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: ' Ada@Example.test ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(GENERIC)).toBeTruthy();
    expect(screen.getByText(/a reset cannot bring them back/)).toBeTruthy();
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/v1/auth/password/forgot');
    expect(bodyOf(call?.[1])).toEqual({ email: 'ada@example.test' });
  });

  it('validates the address before sending anything', async () => {
    const forgot = vi.fn(() => json({ message: GENERIC }, 202));
    mockApi({ ...signedOut, 'POST /api/v1/auth/password/forgot': forgot });
    renderApp('/forgot-password');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    });
    expect(forgot).not.toHaveBeenCalled();
  });

  it('says so when the server cannot send email', async () => {
    mockApi({
      ...signedOut,
      'POST /api/v1/auth/password/forgot': () =>
        json(
          {
            statusCode: 503,
            error: 'SERVICE_UNAVAILABLE',
            message: 'Password recovery by email is not available on this server yet.',
            code: 'EMAIL_UNAVAILABLE',
          },
          503,
        ),
    });
    renderApp('/forgot-password');
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ada@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/not available on this server yet/)).toBeTruthy();
    expect(screen.queryByText(GENERIC)).toBeNull();
  });
});

describe('reset password (web)', () => {
  it('takes the token from the fragment, removes it from the URL and sets the password', async () => {
    const resetCall = vi.fn(() => json({ reset: true }));
    const fetchMock = mockApi({ ...signedOut, 'POST /api/v1/auth/password/reset': resetCall });
    renderApp(`/reset-password#token=${TOKEN}`);
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'violet harbour telescope morning' },
    });
    // Nothing is sent until the person submits.
    expect(resetCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/every device was signed out/)).toBeTruthy();
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/v1/auth/password/reset');
    expect(bodyOf(call?.[1])).toEqual({
      token: TOKEN,
      newPassword: 'violet harbour telescope morning',
    });
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('refuses a weak password locally, and explains an expired link', async () => {
    const resetCall = vi.fn(() =>
      json(
        {
          statusCode: 400,
          error: 'BAD_REQUEST',
          message: 'This reset link is invalid or has expired. Ask for a new one.',
          code: 'INVALID_RESET_TOKEN',
        },
        400,
      ),
    );
    mockApi({ ...signedOut, 'POST /api/v1/auth/password/reset': resetCall });
    renderApp(`/reset-password#token=${TOKEN}`);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(screen.getByLabelText('New password').getAttribute('aria-invalid')).toBe('true');
    });
    expect(resetCall).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'violet harbour telescope morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/invalid, used or expired/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toBeTruthy();
  });

  it('rejects a link without a well-formed token', async () => {
    mockApi(signedOut);
    renderApp('/reset-password#token=not-a-token');
    expect(await screen.findByText('This reset link is incomplete or invalid.')).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
});
