import type { DeviceSessionView } from '@ogc/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HERE = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e01';
const PHONE = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e02';
const LAPTOP = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e03';

function session(id: string, overrides: Partial<DeviceSessionView> = {}): DeviceSessionView {
  return {
    id,
    platform: 'WEB',
    deviceName: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: '2026-10-14T10:00:00.000Z',
    expiresAt: '2026-10-31T10:00:00.000Z',
    current: false,
    ...overrides,
  };
}

describe('devices and security', () => {
  it('lists signed-in devices and signs out a lost one', async () => {
    let sessions = [
      session(HERE, { current: true }),
      session(PHONE, { platform: 'ANDROID', deviceName: 'Pixel 9' }),
    ];
    const revoke = vi.fn(() => {
      sessions = sessions.filter((s) => s.id !== PHONE);
      return json(null, 204);
    });
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/auth/sessions': () => json(sessions),
      [`DELETE /api/v1/auth/sessions/${PHONE}`]: revoke,
    });
    renderApp('/settings/security');
    const list = await screen.findByRole('list', { name: 'Signed-in devices' });
    expect(within(list).getByText(/This device/)).toBeTruthy();
    // The current device cannot be signed out from the list (use Sign out instead).
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: 'Sign out Pixel 9' }));
    expect(await screen.findByText('Pixel 9 was signed out.')).toBeTruthy();
    expect(revoke).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText('Pixel 9')).toBeNull();
    });
  });

  it('signs out every other device', async () => {
    const revokeOthers = vi.fn(() => json({ ended: 2 }));
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/auth/sessions': () =>
        json([session(HERE, { current: true }), session(PHONE), session(LAPTOP)]),
      'POST /api/v1/auth/sessions/revoke-others': revokeOthers,
    });
    renderApp('/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out all other devices' }));
    expect(await screen.findByText('Signed out 2 other devices.')).toBeTruthy();
    expect(revokeOthers).toHaveBeenCalledTimes(1);
  });

  it('changes the password and says other devices were signed out', async () => {
    const change = vi.fn(() => json({ otherSessionsEnded: 1 }));
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/auth/sessions': () => json([session(HERE, { current: true })]),
      'POST /api/v1/auth/password': change,
    });
    renderApp('/settings/security');
    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'violet harbour telescope morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Password changed. 1 other device was signed out.'),
    ).toBeTruthy();
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(bodyOf(call?.[1])).toEqual({
      currentPassword: 'correct horse battery staple',
      newPassword: 'violet harbour telescope morning',
    });
    // The fields are cleared so the password does not linger on screen.
    expect(screen.getByLabelText<HTMLInputElement>('New password').value).toBe('');
  });

  it('checks the new password locally and reports a wrong current password', async () => {
    const change = vi.fn(() =>
      json(
        {
          statusCode: 400,
          error: 'BAD_REQUEST',
          message: 'Current password is not correct',
          code: 'INVALID_PASSWORD',
        },
        400,
      ),
    );
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/auth/sessions': () => json([session(HERE, { current: true })]),
      'POST /api/v1/auth/password': change,
    });
    renderApp('/settings/security');
    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(screen.getByLabelText('New password').getAttribute('aria-invalid')).toBe('true');
    });
    expect(change).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'violet harbour telescope morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Your current password is not correct.')).toBeTruthy();
  });
});
