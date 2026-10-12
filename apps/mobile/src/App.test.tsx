import { describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId } from '@ogc/types';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';

const account: AccountView = {
  ogcId: 'OGC306841127' as OgcId,
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  emailVerified: true,
  accountStatus: 'ACTIVE',
  createdAt: '2026-10-12T10:00:00.000Z',
};

function setup(routes: Record<string, () => Response>) {
  const store: TokenStore = {
    getRefreshToken: () => Promise.resolve(null),
    setRefreshToken: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error('offline'));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store, fetchImpl });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('mobile app', () => {
  it('welcomes signed-out users', async () => {
    await render(<App client={setup({})} />);
    expect(await screen.findByText('Create your OGC ID')).toBeOnTheScreen();
    expect(screen.getByText('I already have one')).toBeOnTheScreen();
  });

  it('signs in and shows the OGC ID prominently', async () => {
    const client = setup({
      'POST /v1/auth/login': () =>
        json({ account, session: {}, tokens: { accessToken: 'a', refreshToken: 'r' } }),
    });
    await render(<App client={client} />);
    await fireEvent.press(await screen.findByText('I already have one'));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.test');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse battery staple');
    await fireEvent.press(screen.getByText('Sign in'));

    expect(await screen.findByText('OGC 306 841 127')).toBeOnTheScreen();
    expect(screen.getByText('Welcome, Ada Lovelace')).toBeOnTheScreen();
  });

  it('shows a generic error for wrong credentials', async () => {
    const client = setup({
      'POST /v1/auth/login': () =>
        json(
          { statusCode: 401, message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
          401,
        ),
    });
    await render(<App client={client} />);
    await fireEvent.press(await screen.findByText('I already have one'));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.test');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByText('Sign in'));
    expect(
      await screen.findByText('That email and password combination is not correct.'),
    ).toBeOnTheScreen();
  });

  it('validates registration input before calling the API', async () => {
    await render(<App client={setup({})} />);
    await fireEvent.press(await screen.findByText('Create your OGC ID'));
    await fireEvent.changeText(screen.getByLabelText('Password'), 'short');
    await fireEvent.press(screen.getByText('Create account'));
    expect(await screen.findByText('Use at least 12 characters')).toBeOnTheScreen();
  });
});
