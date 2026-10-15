import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const signedOutStore: TokenStore = {
  getRefreshToken: () => Promise.resolve(null),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

const TOKEN = `ogc_pr_${'Z'.repeat(43)}`;
const GENERIC =
  'If an account uses this email address, a link to reset its password is on its way.';

function setup(routes: Record<string, () => Response>) {
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({ key, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${key}`));
  }) as unknown as typeof fetch;
  return {
    client: new ApiClient({ baseUrl: '', platform: 'ANDROID', store: signedOutStore, fetchImpl }),
    calls,
  };
}

async function openForgot(client: ApiClient) {
  await render(<App client={client} />);
  await fireEvent.press(await screen.findByText('Sign In'));
  await fireEvent.press(await screen.findByText('Forgot your password?'));
  await screen.findByText('Reset your password');
}

describe('mobile password recovery', () => {
  it('requests a link, then resets with the pasted link', async () => {
    const { client, calls } = setup({
      'POST /v1/auth/password/forgot': () => json({ message: GENERIC }, 202),
      'POST /v1/auth/password/reset': () => json({ reset: true }),
    });
    await openForgot(client);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'Ada@Example.test');
    await fireEvent.press(screen.getByText('Send reset link'));
    expect(await screen.findByText(GENERIC)).toBeOnTheScreen();
    expect(calls.find((c) => c.key === 'POST /v1/auth/password/forgot')?.body).toEqual({
      email: 'ada@example.test',
    });

    await fireEvent.press(screen.getByText('I have the link'));
    await fireEvent.changeText(
      await screen.findByLabelText('Reset link'),
      `https://app.ogc.example/reset-password#token=${TOKEN}`,
    );
    await fireEvent.changeText(
      screen.getByLabelText('New password'),
      'violet harbour telescope morning',
    );
    await fireEvent.press(screen.getByText('Change password'));
    expect(await screen.findByText(/every device was signed out/)).toBeOnTheScreen();
    expect(calls.find((c) => c.key === 'POST /v1/auth/password/reset')?.body).toEqual({
      token: TOKEN,
      newPassword: 'violet harbour telescope morning',
    });
  });

  it('checks the link and password before calling the API', async () => {
    const { client, calls } = setup({
      'POST /v1/auth/password/forgot': () => json({ message: GENERIC }, 202),
    });
    await openForgot(client);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.test');
    await fireEvent.press(screen.getByText('Send reset link'));
    await fireEvent.press(await screen.findByText('I have the link'));
    await fireEvent.changeText(
      await screen.findByLabelText('Reset link'),
      'https://x/reset-password',
    );
    await fireEvent.changeText(screen.getByLabelText('New password'), 'short');
    await fireEvent.press(screen.getByText('Change password'));
    expect(await screen.findByText('Paste the whole link from the email')).toBeOnTheScreen();
    expect(screen.getByText(/at least 12 characters/i)).toBeOnTheScreen();
    expect(calls.some((c) => c.key === 'POST /v1/auth/password/reset')).toBe(false);
  });

  it('explains when the server cannot send email', async () => {
    const { client } = setup({
      'POST /v1/auth/password/forgot': () =>
        json(
          {
            statusCode: 503,
            message: 'Password recovery by email is not available on this server yet.',
            code: 'EMAIL_UNAVAILABLE',
          },
          503,
        ),
    });
    await openForgot(client);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.test');
    await fireEvent.press(screen.getByText('Send reset link'));
    expect(await screen.findByText(/not available on this server yet/)).toBeOnTheScreen();
    expect(screen.queryByText('I have the link')).toBeNull();
  });

  it('explains an expired or used link', async () => {
    const expired = setup({
      'POST /v1/auth/password/forgot': () => json({ message: GENERIC }, 202),
      'POST /v1/auth/password/reset': () =>
        json(
          { statusCode: 400, message: 'This reset link is invalid', code: 'INVALID_RESET_TOKEN' },
          400,
        ),
    });
    await openForgot(expired.client);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.test');
    await fireEvent.press(screen.getByText('Send reset link'));
    await fireEvent.press(await screen.findByText('I have the link'));
    await fireEvent.changeText(await screen.findByLabelText('Reset link'), TOKEN);
    await fireEvent.changeText(
      screen.getByLabelText('New password'),
      'violet harbour telescope morning',
    );
    await fireEvent.press(screen.getByText('Change password'));
    expect(await screen.findByText(/invalid, used or expired/)).toBeOnTheScreen();
  });
});
