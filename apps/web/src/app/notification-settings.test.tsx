import type { NotificationSettingsView } from '@ogc/types';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const defaults: NotificationSettingsView = {
  enabled: true,
  messages: true,
  groups: true,
  channels: true,
  contactRequests: true,
  calls: true,
  preview: 'GENERIC',
  sound: true,
  vibration: true,
  quietHours: { enabled: false, start: 1320, end: 420, timeZone: 'UTC' },
};

function open(options: { failSave?: boolean } = {}) {
  const fetchMock = mockApi({
    ...signedInRoutes(),
    'GET /api/v1/notifications/settings': () => json(defaults),
    'PUT /api/v1/notifications/settings': (_url, init) =>
      options.failSave
        ? json({ code: 'UNAVAILABLE', message: 'down' }, 503)
        : json({ ...defaults, ...(bodyOf(init) as Partial<NotificationSettingsView>) }),
  });
  renderApp('/settings/notifications');
  return fetchMock;
}

const puts = (fetchMock: ReturnType<typeof open>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/v1/notifications/settings' && init?.method === 'PUT')
    .map(([, init]) => bodyOf(init));

describe('web notification settings', () => {
  it('shows the saved settings and saves a change to the account', async () => {
    const fetchMock = open();
    const calls = await screen.findByRole('switch', { name: /Calls/ });
    expect((calls as HTMLInputElement).checked).toBe(true);
    fireEvent.click(calls);
    await waitFor(() => {
      expect(puts(fetchMock)).toEqual([{ calls: false }]);
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('defaults to private previews and explains the sender option', async () => {
    const fetchMock = open();
    const privateChoice = await screen.findByRole('radio', { name: /Private \(recommended\)/ });
    expect((privateChoice as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Show the sender/ }));
    await waitFor(() => {
      expect(puts(fetchMock)).toEqual([{ preview: 'SENDER' }]);
    });
    expect(screen.getByText(/Message text is never included/)).toBeTruthy();
  });

  it('turns on quiet hours in this browser’s time zone', async () => {
    const fetchMock = open();
    fireEvent.click(await screen.findByRole('switch', { name: /Quiet hours/ }));
    await waitFor(() => {
      expect(puts(fetchMock)[0]).toMatchObject({
        quietHours: { enabled: true, start: 1320, end: 420 },
      });
    });
    const zone = (puts(fetchMock)[0] as { quietHours: { timeZone: string } }).quietHours.timeZone;
    expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('reverts and explains when saving fails', async () => {
    open({ failSave: true });
    const messages = await screen.findByRole('switch', { name: /Direct messages/ });
    fireEvent.click(messages);
    expect(await screen.findByText(/could not be saved/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('switch', { name: /Direct messages/ }).checked).toBe(
      true,
    );
  });

  it('offers no browser push button (only what works)', async () => {
    open();
    await screen.findByRole('switch', { name: /Calls/ });
    expect(screen.queryByRole('button', { name: /browser notifications/i })).toBeNull();
    expect(screen.getByText(/browser push notifications are not available/)).toBeTruthy();
  });
});
