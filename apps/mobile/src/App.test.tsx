import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId, OwnProfile, PublicProfile } from '@ogc/types';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { shareMessage } from './lib/share';

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
  bio: 'Mathematician.',
  avatarUrl: null,
  memberSince: account.createdAt,
  privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
};

const grace: PublicProfile = {
  ogcId: 'OGC482731905' as OgcId,
  displayName: 'Grace Hopper',
  bio: null,
  avatarUrl: null,
  memberSince: null,
  relationship: 'NONE',
  canSendContactRequest: true,
  pendingRequestId: null,
};

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const tokens = { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_test' };
const signedIn: Record<string, () => Response> = {
  'POST /v1/auth/login': () => json({ account, session: {}, tokens }),
  'GET /v1/profile': () => json(ownProfile),
};

const memoryStore: TokenStore = {
  getRefreshToken: () => Promise.resolve(null),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function setup(routes: Record<string, () => Response>, baseUrl = '') {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init.method ?? 'GET'} ${url.replace(baseUrl, '')}`;
    calls.push({ key, init });
    const route = routes[key];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${key}`));
  }) as unknown as typeof fetch;
  return {
    client: new ApiClient({ baseUrl, platform: 'ANDROID', store: memoryStore, fetchImpl }),
    calls,
  };
}

async function signIn() {
  await fireEvent.press(await screen.findByText('I already have one'));
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.test');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse battery staple');
  await fireEvent.press(screen.getByText('Sign in'));
}

beforeEach(() => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

describe('mobile app', () => {
  it('welcomes signed-out users', async () => {
    await render(<App client={setup({}).client} />);
    expect(await screen.findByText('Create your OGC ID')).toBeOnTheScreen();
    expect(screen.getByText('I already have one')).toBeOnTheScreen();
  });

  it('signs in and shows the OGC ID prominently', async () => {
    await render(<App client={setup(signedIn).client} />);
    await signIn();
    expect(await screen.findByText('OGC 306 841 127')).toBeOnTheScreen();
    expect(screen.getByText('Mathematician.')).toBeOnTheScreen();
  });

  it('shows a generic error for wrong credentials', async () => {
    const { client } = setup({
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
    await render(<App client={setup({}).client} />);
    await fireEvent.press(await screen.findByText('Create your OGC ID'));
    await fireEvent.changeText(screen.getByLabelText('Password'), 'short');
    await fireEvent.press(screen.getByText('Create account'));
    expect(await screen.findByText('Use at least 12 characters')).toBeOnTheScreen();
  });
});

describe('identity sharing', () => {
  it('renders a QR code that encodes only the public identity link', async () => {
    await render(<App client={setup(signedIn).client} />);
    await signIn();
    await fireEvent.press(await screen.findByText('Show my QR code'));
    const qr = await screen.findByTestId('ogc-qr');
    expect(qr.props.accessibilityLabel).toBe('QR code for OGC306841127');
    expect(qr.props.accessibilityHint).toBe('ogc://id/OGC306841127');
  });

  it('shares public identity data only', () => {
    const message = shareMessage(account.ogcId, 'Ada Lovelace');
    expect(message).toContain('OGC 306 841 127');
    expect(message).toContain('ogc://id/OGC306841127');
    expect(message).not.toMatch(/ogc_(at|rt)_|@example|password|token/i);
  });
});

describe('discovery and contacts', () => {
  it('finds someone by OGC ID and sends a contact request with the bearer token', async () => {
    let requested = false;
    const { client, calls } = setup({
      ...signedIn,
      'GET /v1/discovery/ogc/OGC482731905': () =>
        json(
          requested
            ? {
                ...grace,
                relationship: 'OUTGOING_REQUEST',
                canSendContactRequest: false,
                pendingRequestId: 'r1',
              }
            : grace,
        ),
      'POST /v1/contacts/requests': () => {
        requested = true;
        return json({ relationship: 'OUTGOING_REQUEST' }, 201);
      },
    });
    await render(<App client={client} />);
    await signIn();
    await fireEvent.press(await screen.findByText('Discover people'));
    await fireEvent.changeText(screen.getByLabelText('OGC ID'), 'ogc 482 731 905');
    await fireEvent.press(screen.getByText('Find'));
    await fireEvent.press(await screen.findByText('Add contact'));
    expect(await screen.findByText('Request sent')).toBeOnTheScreen();

    const post = calls.find((c) => c.key === 'POST /v1/contacts/requests');
    expect(JSON.parse(post?.init.body as string)).toEqual({ ogcId: 'OGC482731905' });
    expect((post?.init.headers as Record<string, string>).Authorization).toBe('Bearer ogc_at_test');
  });

  it('accepts an incoming request from the contacts screen', async () => {
    let accepted = false;
    const person = { ogcId: 'OGC482731905', displayName: 'Grace Hopper', avatarUrl: null };
    const { client } = setup({
      ...signedIn,
      'GET /v1/contacts': () =>
        json({
          items: accepted ? [{ profile: person, since: account.createdAt }] : [],
          nextCursor: null,
        }),
      'GET /v1/contacts/requests/incoming': () =>
        json({
          items: accepted ? [] : [{ id: 'req-1', profile: person, createdAt: account.createdAt }],
          nextCursor: null,
        }),
      'POST /v1/contacts/requests/req-1/accept': () => {
        accepted = true;
        return json(null, 204);
      },
    });
    await render(<App client={client} />);
    await signIn();
    await fireEvent.press(await screen.findByText('Contacts'));
    expect(
      await screen.findByText('No contacts yet. Find people by their OGC ID.'),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('tab', { name: 'Requests' }));
    await fireEvent.press(await screen.findByText('Accept'));
    await fireEvent.press(screen.getByRole('tab', { name: 'Contacts' }));
    expect(await screen.findByText('Grace Hopper')).toBeOnTheScreen();
  });

  it('opens an ogc:// identity link as a profile without adding the person', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('ogc://id/OGC482731905');
    const { client, calls } = setup({
      ...signedIn,
      'GET /v1/profiles/OGC482731905': () => json(grace),
    });
    await render(<App client={client} />);
    await signIn();
    expect(await screen.findByText('Grace Hopper')).toBeOnTheScreen();
    expect(screen.getByText('Add contact')).toBeOnTheScreen();
    expect(calls.some((c) => c.key === 'POST /v1/contacts/requests')).toBe(false);
  });

  it('ignores links that are not OGC identity links', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('ogc://id/OGC482731905?token=secret');
    const { client, calls } = setup(signedIn);
    await render(<App client={client} />);
    await signIn();
    expect(await screen.findByText('OGC 306 841 127')).toBeOnTheScreen();
    expect(calls.some((c) => c.key.includes('/v1/profiles/'))).toBe(false);
  });
});

describe('profile photos', () => {
  it('requests avatars with the bearer token so privacy rules apply', async () => {
    const { client } = setup(signedIn, 'https://api.ogc.test/api');
    expect(client.avatarSource('/api/v1/profiles/OGC306841127/avatar?v=ab12cd34')).toBeNull();
    await client.login('ada@example.test', 'pw');
    expect(client.avatarSource('/api/v1/profiles/OGC306841127/avatar?v=ab12cd34')).toEqual({
      uri: 'https://api.ogc.test/api/v1/profiles/OGC306841127/avatar?v=ab12cd34',
      headers: { Authorization: 'Bearer ogc_at_test' },
    });
  });
});
