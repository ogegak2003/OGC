import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { AccountView, OgcId, OwnProfile } from '@ogc/types';
import { resolveTheme } from '@ogc/ui';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ApiClient } from './api/client';
import type { TokenStore } from './auth/token-store';
import { App } from './App';
import { FakeEngine, conversationView, fakeMessaging } from './test/fake-messaging';
import { applyTheme, color, themedStyles } from './theme';
import { parseAppearance } from './theme/ThemeProvider';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

afterEach(() => {
  applyTheme('dark', 'champagne');
});

describe('mobile theme', () => {
  it('rebuilds themed style sheets after a theme change', () => {
    const styles = themedStyles(() =>
      StyleSheet.create({ box: { backgroundColor: color.background, borderColor: color.accent } }),
    );
    expect(styles.box.backgroundColor).toBe(resolveTheme('dark', 'champagne').background);
    applyTheme('light', 'emerald');
    expect(styles.box.backgroundColor).toBe(resolveTheme('light', 'emerald').background);
    expect(styles.box.borderColor).toBe(resolveTheme('light', 'emerald').accent);
    expect(color.accent).toBe(resolveTheme('light', 'emerald').accent);
  });

  it('reads saved appearance safely', () => {
    expect(parseAppearance('{"preference":"light","accent":"steel"}')).toEqual({
      preference: 'light',
      accent: 'steel',
    });
    expect(parseAppearance('{"preference":"neon"}')).toEqual({
      preference: 'dark',
      accent: 'champagne',
    });
    expect(parseAppearance('nonsense')).toEqual({ preference: 'dark', accent: 'champagne' });
    expect(parseAppearance(null)).toEqual({ preference: 'dark', accent: 'champagne' });
  });
});

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
  bio: null,
  avatarUrl: null,
  memberSince: account.createdAt,
  privacy: { profileVisibility: 'CONTACTS', discoverable: true, contactRequests: 'EVERYONE' },
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

const tokens: TokenStore = {
  getRefreshToken: () => Promise.resolve('ogc_rt_test'),
  setRefreshToken: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function client() {
  const routes: Record<string, () => Response> = {
    'POST /v1/auth/refresh': () =>
      json({
        account,
        session: {},
        tokens: { accessToken: 'ogc_at_test', refreshToken: 'ogc_rt_next' },
      }),
    'GET /v1/auth/me': () => json(account),
    'GET /v1/profile': () => json(ownProfile),
    'GET /v1/calls?limit=50': () => json({ items: [], nextCursor: null }),
  };
  const fetchImpl = jest.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    return route ? Promise.resolve(route()) : Promise.reject(new Error(`offline: ${url}`));
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: '', platform: 'ANDROID', store: tokens, fetchImpl });
}

describe('mobile appearance screen', () => {
  it('switches to Ivory and Emerald from settings, keeping the place in the app', async () => {
    const messaging = fakeMessaging(new FakeEngine([conversationView()]));
    await render(<App client={client()} messaging={messaging.dependencies} />);
    await fireEvent.press(await screen.findByRole('tab', { name: 'You' }));
    // The row, not the section header above it.
    const rows = await screen.findAllByText('Appearance');
    await fireEvent.press(rows[rows.length - 1] as never);
    expect(await screen.findByRole('radio', { name: 'Obsidian, Dark' })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Obsidian, Dark' }).props.accessibilityState).toEqual({
      checked: true,
    });

    await fireEvent.press(screen.getByRole('radio', { name: 'Ivory, Light' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Emerald' }));

    expect(color.background).toBe(resolveTheme('light', 'emerald').background);
    expect(color.accent).toBe(resolveTheme('light', 'emerald').accent);
    // Still on the Appearance screen (the navigation stack survived the rebuild).
    expect(screen.getByRole('radio', { name: 'Ivory, Light' }).props.accessibilityState).toEqual({
      checked: true,
    });
    expect(screen.getByRole('radio', { name: 'Emerald' }).props.accessibilityState).toEqual({
      checked: true,
    });
  });

  it('never shows globe imagery on the welcome screen', async () => {
    const signedOut: TokenStore = { ...tokens, getRefreshToken: () => Promise.resolve(null) };
    await render(
      <App client={new ApiClient({ baseUrl: '', platform: 'ANDROID', store: signedOut })} />,
    );
    expect(await screen.findByText('Private conversations, one OGC ID.')).toBeOnTheScreen();
    expect(screen.getByText('Create Account')).toBeOnTheScreen();
    expect(screen.queryByText(/WORLD OF POSSIBILITIES/i)).toBeNull();
    // The only image is the OGC logo (no globe or photo).
    const images = screen.getAllByRole('image');
    expect(images).toHaveLength(1);
    expect(images[0]?.props.accessibilityLabel).toBe('OGC');
  });
});
