import type { BridgeCallView, BridgeStatusView, ContactView, OgcId } from '@ogc/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

/*
 * OGC Bridge screens against a mocked API. Nothing here reaches a provider or a telephone;
 * "simulated" responses mirror what the development simulator reports.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GRACE = 'OGC482731905' as OgcId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function status(overrides: Partial<BridgeStatusView> = {}): BridgeStatusView {
  return {
    enabled: true,
    provider: 'simulated',
    liveDialing: false,
    countries: [{ code: 'KE', name: 'Kenya', callingCode: '254' }],
    number: null,
    verification: null,
    limits: { maxCallSeconds: 1800, callsPerDay: 20, concurrentCalls: 1 },
    ...overrides,
  };
}

const linked = {
  id: 'n1',
  country: 'KE',
  maskedNumber: '+254 7•• •••000',
  status: 'VERIFIED' as const,
  verifiedAt: '2026-10-16T10:00:00.000Z',
  allowContactCalls: true,
};

const contact: ContactView = {
  profile: { ogcId: GRACE, displayName: 'Grace Hopper', avatarUrl: null },
  since: '2026-10-01T00:00:00.000Z',
};

function callView(overrides: Partial<BridgeCallView> = {}): BridgeCallView {
  return {
    id: 'call-1',
    callee: { ogcId: GRACE, displayName: 'Grace Hopper' },
    country: 'KE',
    status: 'RINGING',
    simulated: true,
    createdAt: '2026-10-16T12:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    durationSeconds: null,
    failureReason: null,
    charge: null,
    ...overrides,
  };
}

/** Routes for the calling area with a linked number. */
function callingRoutes(eligibility = { eligible: true, reason: null as string | null }) {
  return {
    ...signedInRoutes(),
    'GET /api/v1/bridge': () => json(status({ number: linked })),
    'GET /api/v1/contacts': () => json({ items: [contact], nextCursor: null }),
    'GET /api/v1/bridge/calls': () => json([]),
    'GET /api/v1/bridge/usage': () => json({ entries: [], callsToday: 0 }),
    [`GET /api/v1/bridge/eligibility?ogcId=${GRACE}`]: () => json(eligibility),
  };
}

describe('OGC Bridge page', () => {
  it('says plainly when Bridge is switched off, and offers nothing to do', async () => {
    mockApi({ ...signedInRoutes(), 'GET /api/v1/bridge': () => json(status({ enabled: false })) });
    renderApp('/calls/bridge');
    expect(await screen.findByText('OGC Bridge is not available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send code' })).toBeNull();
    expect(screen.queryByRole('button', { name: /call/i })).toBeNull();
  });

  it('says "not configured" instead of pretending, when no provider is set up', async () => {
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/bridge': () => json(status({ provider: 'disabled' })),
    });
    renderApp('/calls/bridge');
    expect(await screen.findByText(/no telephone provider is set up yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send code' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Contact' })).toBeNull();
  });

  it('labels the simulator and discloses that telephone calls are not end-to-end encrypted', async () => {
    mockApi({ ...signedInRoutes(), 'GET /api/v1/bridge': () => json(status()) });
    renderApp('/calls/bridge');
    expect(await screen.findByText(/no telephone rings and nothing is charged/i)).toBeTruthy();
    expect(screen.getByText('Not end-to-end encrypted')).toBeTruthy();
  });

  it('links a number only with consent, then verifies the code', async () => {
    let current = status();
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/bridge': () => json(current),
      'POST /api/v1/bridge/number/verification': () => {
        current = status({
          verification: {
            id: 'v1',
            delivery: 'simulated',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
            attemptsRemaining: 5,
          },
        });
        return json(current.verification, 201);
      },
      'POST /api/v1/bridge/number/verify': (_url, init) => {
        if ((bodyOf(init) as { code: string }).code !== '246810') {
          return json(
            {
              statusCode: 400,
              error: 'Bad Request',
              code: 'VERIFICATION_FAILED',
              message: 'That code is not correct.',
            },
            400,
          );
        }
        current = status({ number: { ...linked, allowContactCalls: false } });
        return json(current.number);
      },
      'GET /api/v1/contacts': () => json({ items: [], nextCursor: null }),
      'GET /api/v1/bridge/calls': () => json([]),
      'GET /api/v1/bridge/usage': () => json({ entries: [], callsToday: 0 }),
    });
    renderApp('/calls/bridge');

    fireEvent.change(await screen.findByLabelText('Mobile number'), {
      target: { value: '0700 000 000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/confirm that this is your number/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('checkbox', { name: /this is my number/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    const code = await screen.findByLabelText('Verification code');
    const sent = fetchMock.mock.calls.find(([url]) => url === '/api/v1/bridge/number/verification');
    expect(bodyOf(sent?.[1])).toEqual({ country: 'KE', number: '0700 000 000', consent: true });
    expect(screen.getByText(/no SMS was sent/i)).toBeTruthy();
    expect(screen.getByText(/new code in \d+ s/i)).toBeTruthy();

    fireEvent.change(code, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify number' }));
    expect(await screen.findByText('That code is not correct.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify number' }));
    expect(await screen.findByText('+254 7•• •••000')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('switch').checked).toBe(false);
  });

  it('explains why a contact cannot be called, without revealing their number', async () => {
    mockApi(callingRoutes({ eligible: false, reason: 'UNAVAILABLE' }));
    renderApp('/calls/bridge');
    fireEvent.change(await screen.findByRole('combobox', { name: 'Contact' }), {
      target: { value: GRACE },
    });
    expect(await screen.findByText(/cannot be reached through OGC Bridge/i)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Start simulated call' }).disabled,
    ).toBe(true);
  });

  it('starts an idempotent call, shows server-reported progress, and ends it', async () => {
    let ended = false;
    const fetchMock = mockApi({
      ...callingRoutes(),
      'POST /api/v1/bridge/calls': () => json(callView(), 201),
      'GET /api/v1/bridge/calls/call-1': () => json(callView()),
      'POST /api/v1/bridge/calls/call-1/end': () => {
        ended = true;
        return json(callView({ status: 'CANCELED', endedAt: '2026-10-16T12:00:05.000Z' }));
      },
    });
    renderApp('/calls/bridge');
    fireEvent.change(await screen.findByRole('combobox', { name: 'Contact' }), {
      target: { value: GRACE },
    });
    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start simulated call' });
    await waitFor(() => {
      expect(start.disabled).toBe(false);
    });
    fireEvent.click(start);

    const panel = await screen.findByRole('heading', {
      name: /Grace Hopper: Ringing \(simulated\)/,
    });
    expect(panel).toBeTruthy();
    const request = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/bridge/calls' && init?.method === 'POST',
    );
    const body = bodyOf(request?.[1]) as { ogcId: string; idempotencyKey: string };
    expect(body.ogcId).toBe(GRACE);
    expect(body.idempotencyKey).toMatch(UUID);

    fireEvent.click(screen.getByRole('button', { name: 'End call' }));
    expect(await screen.findByRole('heading', { name: /Canceled/ })).toBeTruthy();
    expect(ended).toBe(true);
  });

  it('asks before unlinking the number', async () => {
    let unlinked = false;
    mockApi({
      ...callingRoutes(),
      'GET /api/v1/bridge': () => json(status({ number: unlinked ? null : linked })),
      'DELETE /api/v1/bridge/number': () => {
        unlinked = true;
        return new Response(null, { status: 204 });
      },
    });
    renderApp('/calls/bridge');
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink number' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink your phone number?' });
    expect(unlinked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink number' }));
    expect(await screen.findByLabelText('Mobile number')).toBeTruthy();
    expect(unlinked).toBe(true);
  });
});

describe('Calls page entry to OGC Bridge', () => {
  const callsRoutes = {
    ...signedInRoutes(),
    'GET /api/v1/calls?limit=50': () => json({ items: [], nextCursor: null }),
  };

  it('appears only when Bridge is switched on', async () => {
    mockApi({ ...callsRoutes, 'GET /api/v1/bridge': () => json(status()) });
    renderApp('/calls');
    const entry = await screen.findByRole('link', { name: /OGC Bridge/ });
    expect(entry.getAttribute('href')).toBe('/calls/bridge');
  });

  it('stays hidden when Bridge is off', async () => {
    let asked = false;
    mockApi({
      ...callsRoutes,
      'GET /api/v1/bridge': () => {
        asked = true;
        return json(status({ enabled: false }));
      },
    });
    renderApp('/calls');
    expect(await screen.findByRole('heading', { name: 'Recent calls' })).toBeTruthy();
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(screen.queryByRole('link', { name: /OGC Bridge/ })).toBeNull();
  });
});
