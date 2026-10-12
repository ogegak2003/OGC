import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareableIdentity } from '../lib/share';
import {
  bodyOf,
  emptyPage,
  json,
  mockApi,
  ownProfile,
  publicProfile,
  renderApp,
  signedInRoutes,
  unauthenticated,
} from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const notFound = () =>
  json(
    { statusCode: 404, error: 'NOT_FOUND', message: 'No OGC account found', code: 'NOT_FOUND' },
    404,
  );

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('My OGC', () => {
  it('shows the OGC ID, bio, and a QR code holding only the public identity link', async () => {
    mockApi(signedInRoutes(ownProfile({ bio: 'Mathematician.' })));
    renderApp('/home');
    expect(await screen.findByText('OGC 306 841 127')).toBeTruthy();
    expect(screen.getByText('Mathematician.')).toBeTruthy();
    const qr = screen.getByRole('img', { name: 'QR code for OGC306841127' });
    const payload = qr.closest('figure')?.getAttribute('data-payload');
    expect(payload).toBe('ogc://id/OGC306841127');
    expect(payload).not.toMatch(/token|@|session|ogc_(at|rt)_/i);
  });

  it('shares with the native share sheet, or copies when unavailable', async () => {
    mockApi(signedInRoutes());
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp('/home');
    fireEvent.click(await screen.findByRole('button', { name: 'Share my OGC' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const shared = writeText.mock.calls[0]?.[0] ?? '';
    expect(shared).toContain('OGC 306 841 127');
    expect(shared).toContain('ogc://id/OGC306841127');
    expect(shared).toContain('/id/OGC306841127');
    expect(await screen.findByText('Your OGC details were copied to the clipboard.')).toBeTruthy();
  });

  it('builds share content from public data only', () => {
    const identity = shareableIdentity(ownProfile().ogcId, 'Ada', 'https://ogc.example');
    expect(identity.url).toBe('https://ogc.example/id/OGC306841127');
    expect(JSON.stringify(identity)).not.toMatch(/token|password|@example|session/i);
  });
});

describe('editing the profile', () => {
  it('validates and saves display name and bio', async () => {
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'PATCH /api/v1/profile': () =>
        json(ownProfile({ displayName: 'Ada King', bio: 'Poet of science' })),
    });
    renderApp('/profile/edit');
    await screen.findByLabelText('Display name');
    fill('Display name', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Enter a display name')).toBeTruthy();

    fill('Display name', 'Ada King');
    fill('About', 'Poet of science');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(bodyOf(call?.[1])).toEqual({ displayName: 'Ada King', bio: 'Poet of science' });
    });
  });

  it('refuses unsupported photo types before uploading', async () => {
    const fetchMock = mockApi(signedInRoutes());
    const { container } = renderApp('/profile/edit');
    await screen.findByLabelText('Display name');
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error('file input missing');
    const file = new File(['MZ'], 'program.exe', { type: 'application/x-msdownload' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('Choose a JPEG, PNG or WebP image.')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/avatar')),
    ).toBe(false);
  });
});

describe('discovery', () => {
  it('finds a profile by OGC ID as typed and sends a contact request', async () => {
    let requested = false;
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/discovery/ogc/OGC482731905': () =>
        json(
          requested
            ? publicProfile({
                relationship: 'OUTGOING_REQUEST',
                canSendContactRequest: false,
                pendingRequestId: 'r1',
              })
            : publicProfile(),
        ),
      'POST /api/v1/contacts/requests': () => {
        requested = true;
        return json({ relationship: 'OUTGOING_REQUEST' }, 201);
      },
    });
    renderApp('/discover');
    await screen.findByLabelText('OGC ID');
    fill('OGC ID', 'ogc 482 731 905');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const card = await screen.findByRole('article', { name: 'Profile of Grace Hopper' });
    fireEvent.click(within(card).getByRole('button', { name: 'Add contact' }));
    expect(await screen.findByText('Request sent')).toBeTruthy();
    const post = fetchMock.mock.calls.find(([url]) => url === '/api/v1/contacts/requests');
    expect(bodyOf(post?.[1])).toEqual({ ogcId: 'OGC482731905' });
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy();
  });

  it('validates input locally and reports unknown IDs without details', async () => {
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/discovery/ogc/OGC999999999': notFound,
    });
    renderApp('/discover');
    await screen.findByLabelText('OGC ID');
    fill('OGC ID', 'OGC 12');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('Enter a valid OGC ID, e.g. OGC 482 731 905')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/discovery/')),
    ).toBe(false);

    fill('OGC ID', 'OGC999999999');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText(/No OGC account was found for that ID/)).toBeTruthy();
  });

  it('accepts an incoming request from the profile card', async () => {
    let accepted = false;
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/discovery/ogc/OGC482731905': () =>
        json(
          accepted
            ? publicProfile({ relationship: 'CONTACT', canSendContactRequest: false })
            : publicProfile({
                relationship: 'INCOMING_REQUEST',
                canSendContactRequest: false,
                pendingRequestId: 'req-1',
              }),
        ),
      'POST /api/v1/contacts/requests/req-1/accept': () => {
        accepted = true;
        return json(null, 204);
      },
    });
    renderApp('/discover');
    await screen.findByLabelText('OGC ID');
    fill('OGC ID', 'OGC482731905');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Contact')).toBeTruthy();
  });

  it('asks for confirmation before blocking', async () => {
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/discovery/ogc/OGC482731905': () => json(publicProfile()),
      'POST /api/v1/blocks/OGC482731905': () => json(null, 204),
    });
    renderApp('/discover');
    await screen.findByLabelText('OGC ID');
    fill('OGC ID', 'OGC482731905');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/blocks/')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Confirm block/ }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/blocks/OGC482731905')).toBe(
        true,
      );
    });
  });
});

describe('deep links', () => {
  it('opens /id/:ogcId as a profile without adding the person', async () => {
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/profiles/OGC482731905': () => json(publicProfile()),
    });
    renderApp('/id/OGC482731905');
    expect(await screen.findByRole('article', { name: 'Profile of Grace Hopper' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('sends signed-out visitors to sign in, then back to the profile', async () => {
    mockApi({
      'GET /api/v1/auth/me': unauthenticated,
      'POST /api/v1/auth/refresh': unauthenticated,
    });
    renderApp('/id/OGC482731905');
    expect(await screen.findByRole('heading', { name: 'Sign in to OGC' })).toBeTruthy();
  });

  it('explains unavailable profiles without saying why', async () => {
    mockApi({ ...signedInRoutes(), 'GET /api/v1/profiles/OGC482731905': notFound });
    renderApp('/id/OGC482731905');
    expect(await screen.findByText(/This OGC profile is not available/)).toBeTruthy();
  });
});

describe('contacts', () => {
  it('lists contacts and handles incoming requests', async () => {
    let accepted = false;
    const person = { ogcId: 'OGC482731905', displayName: 'Grace Hopper', avatarUrl: null };
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/contacts': () =>
        json(
          accepted
            ? { items: [{ profile: person, since: '2026-10-12T10:00:00.000Z' }], nextCursor: null }
            : emptyPage,
        ),
      'GET /api/v1/contacts/requests/incoming': () =>
        json(
          accepted
            ? emptyPage
            : {
                items: [{ id: 'r9', profile: person, createdAt: '2026-10-12T10:00:00.000Z' }],
                nextCursor: null,
              },
        ),
      'GET /api/v1/contacts/requests/outgoing': () => json(emptyPage),
      'POST /api/v1/contacts/requests/r9/accept': () => {
        accepted = true;
        return json(null, 204);
      },
    });
    renderApp('/contacts');
    expect(await screen.findByText(/No contacts yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Requests/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Contacts' }));
    expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  });
});

describe('privacy and safety', () => {
  it('saves privacy settings', async () => {
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'PATCH /api/v1/profile': () =>
        json(
          ownProfile({
            privacy: {
              profileVisibility: 'EVERYONE',
              discoverable: false,
              contactRequests: 'NOBODY',
            },
          }),
        ),
    });
    renderApp('/settings/privacy');
    fireEvent.click(await screen.findByLabelText(/Everyone/, { selector: 'input' }));
    fireEvent.click(screen.getByLabelText(/Only my existing contacts/, { selector: 'input' }));
    fireEvent.click(screen.getByLabelText(/^Nobody/, { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save privacy settings' }));
    expect(await screen.findByText('Privacy settings saved.')).toBeTruthy();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(bodyOf(patch?.[1])).toEqual({
      privacy: { profileVisibility: 'EVERYONE', discoverable: false, contactRequests: 'NOBODY' },
    });
  });

  it('lists blocked people and unblocks them', async () => {
    let blocked = true;
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/blocks': () =>
        json(
          blocked
            ? {
                items: [
                  {
                    profile: { ogcId: 'OGC482731905', displayName: 'Pest', avatarUrl: null },
                    blockedAt: '2026-10-12T10:00:00.000Z',
                  },
                ],
                nextCursor: null,
              }
            : emptyPage,
        ),
      'DELETE /api/v1/blocks/OGC482731905': () => {
        blocked = false;
        return json(null, 204);
      },
    });
    renderApp('/settings/blocked');
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock' }));
    expect(await screen.findByText('You have not blocked anyone.')).toBeTruthy();
  });

  it('submits a report with a controlled category', async () => {
    const fetchMock = mockApi({
      ...signedInRoutes(),
      'POST /api/v1/reports/users': () => json({ received: true }, 202),
    });
    renderApp('/report/OGC482731905');
    fireEvent.click(await screen.findByRole('button', { name: 'Send report' }));
    expect(await screen.findByText('Choose a report category')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What is the problem?'), {
      target: { value: 'HARASSMENT' },
    });
    fireEvent.change(screen.getByLabelText('Details (optional)'), { target: { value: 'Threats' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Our moderators will review your report/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([url]) => url === '/api/v1/reports/users');
    expect(bodyOf(post?.[1])).toEqual({
      ogcId: 'OGC482731905',
      category: 'HARASSMENT',
      description: 'Threats',
    });
  });
});
