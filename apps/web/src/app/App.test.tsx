import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function mockFetch(response: Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() => response),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the OGC brand and an example identity', () => {
    mockFetch(new Promise<Response>(() => undefined));
    render(<App />);
    expect(screen.getByRole('heading', { name: 'OGC' })).toBeTruthy();
    expect(screen.getByText('OGC000001')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Checking API');
  });

  it('shows the API as online when the health check succeeds', async () => {
    mockFetch(
      Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    render(<App />);
    expect(await screen.findByText('API online')).toBeTruthy();
  });

  it('shows the API as unreachable when the health check fails', async () => {
    mockFetch(Promise.reject(new TypeError('network error')));
    render(<App />);
    expect(await screen.findByText('API unreachable')).toBeTruthy();
  });
});
