import {
  DEFAULT_ACCENT,
  THEME_ACCENTS,
  type ThemeAccent,
  type ThemeMode,
  type ThemePreference,
} from '@ogc/ui';
import { createContext, useContext } from 'react';

/** A person's appearance choice, kept per browser. */
export interface Appearance {
  preference: ThemePreference;
  accent: ThemeAccent;
}

export const DEFAULT_APPEARANCE: Appearance = { preference: 'dark', accent: DEFAULT_ACCENT };
const STORAGE_KEY = 'ogc.appearance';
const PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

/** Reads the saved choice; anything missing, malformed or unreadable falls back to the default. */
export function loadAppearance(storage: Storage | undefined = safeStorage()): Appearance {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as { preference?: unknown; accent?: unknown };
    return {
      preference:
        PREFERENCES.find((value) => value === parsed.preference) ?? DEFAULT_APPEARANCE.preference,
      accent: THEME_ACCENTS.find((value) => value === parsed.accent) ?? DEFAULT_APPEARANCE.accent,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(
  appearance: Appearance,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Private windows and blocked storage: the choice simply lasts for this visit.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function systemMode(): ThemeMode {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function effectiveMode(preference: ThemePreference): ThemeMode {
  return preference === 'system' ? systemMode() : preference;
}

/** Applies a theme to the document: every `--ogc-color-*` variable follows at once. */
export function applyAppearance(
  appearance: Appearance,
  mode: ThemeMode = effectiveMode(appearance.preference),
  root = document.documentElement,
): void {
  root.dataset.theme = mode;
  root.dataset.accent = appearance.accent;
}

export interface ThemeState extends Appearance {
  /** The mode actually shown (system resolved). */
  mode: ThemeMode;
  setPreference: (preference: ThemePreference) => void;
  setAccent: (accent: ThemeAccent) => void;
}

export const ThemeContext = createContext<ThemeState>({
  ...DEFAULT_APPEARANCE,
  mode: 'dark',
  setPreference: () => undefined,
  setAccent: () => undefined,
});

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
