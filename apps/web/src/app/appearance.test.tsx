import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeControls } from '../components/ThemeControls';
import { emptyPage, json, mockApi, renderApp, signedInRoutes } from '../test/helpers';
import { ThemeProvider } from '../theme/ThemeProvider';
import { loadAppearance } from '../theme/theme';

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderControls() {
  return render(
    <ThemeProvider>
      <ThemeControls />
    </ThemeProvider>,
  );
}

describe('appearance', () => {
  it('starts in the Obsidian dark theme with the Champagne accent', async () => {
    renderControls();
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(document.documentElement.dataset.accent).toBe('champagne');
    expect(screen.getByRole('radio', { name: /Obsidian/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Champagne' })).toHaveProperty('checked', true);
  });

  it('switches mode and accent for the whole document and remembers them', async () => {
    renderControls();
    fireEvent.click(screen.getByRole('radio', { name: /Ivory/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Emerald' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
    });
    expect(document.documentElement.dataset.accent).toBe('emerald');
    expect(loadAppearance()).toEqual({ preference: 'light', accent: 'emerald' });

    // A new visit starts from the saved choice.
    cleanup();
    renderControls();
    expect(screen.getByRole('radio', { name: /Ivory/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Emerald' })).toHaveProperty('checked', true);
  });

  it('follows the device appearance when set to System', async () => {
    let listener: (() => void) | undefined;
    let light = true;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return light;
        },
        addEventListener: (_: string, fn: () => void) => {
          listener = fn;
        },
        removeEventListener: vi.fn(),
      })),
    );
    renderControls();
    fireEvent.click(screen.getByRole('radio', { name: /System/ }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
    });
    light = false;
    listener?.();
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
  });

  it('ignores corrupt saved values', () => {
    window.localStorage.setItem('ogc.appearance', '{"preference":"neon","accent":"pink"}');
    expect(loadAppearance()).toEqual({ preference: 'dark', accent: 'champagne' });
    window.localStorage.setItem('ogc.appearance', 'not json');
    expect(loadAppearance()).toEqual({ preference: 'dark', accent: 'champagne' });
  });
});

describe('app shell', () => {
  it('opens the real new-message dialog from the Create menu', async () => {
    mockApi({ ...signedInRoutes(), 'GET /api/v1/contacts': () => json(emptyPage) });
    renderApp('/settings/appearance');
    const bar = await screen.findAllByRole('button', { name: /^New$/ });
    fireEvent.click(required(bar[0]));
    fireEvent.click(required(screen.getAllByRole('button', { name: 'New message' })[0]));
    expect(await screen.findByRole('dialog', { name: 'New conversation' })).toBeTruthy();
  });

  it('collapses the sidebar to icons and remembers it', async () => {
    mockApi(signedInRoutes());
    renderApp('/settings/appearance');
    const toggle = await screen.findByRole('button', { name: 'Collapse sidebar' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('ogc.sidebar')).toBe('collapsed');
    // Collapsed links keep their accessible names (and show them as tooltips).
    const [sidebar] = screen.getAllByRole('navigation', { name: 'Main' });
    const home = within(required(sidebar)).getByRole('link', { name: 'Home' });
    expect(home.getAttribute('title')).toBe('Home');
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected element');
  return value;
}
