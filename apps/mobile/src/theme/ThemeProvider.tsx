import {
  DEFAULT_ACCENT,
  THEME_ACCENTS,
  type ThemeAccent,
  type ThemeMode,
  type ThemePreference,
} from '@ogc/ui';
import * as SecureStore from 'expo-secure-store';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import { applyTheme } from './index';

export interface Appearance {
  preference: ThemePreference;
  accent: ThemeAccent;
}

export const DEFAULT_APPEARANCE: Appearance = { preference: 'dark', accent: DEFAULT_ACCENT };
const PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

/** Where the appearance choice is kept (not secret, but already available and per-device). */
export interface AppearanceStore {
  load: () => Promise<string | null>;
  save: (value: string) => Promise<void>;
}

const KEY = 'ogc.appearance';
export const secureAppearanceStore: AppearanceStore = {
  load: () => SecureStore.getItemAsync(KEY),
  save: (value) => SecureStore.setItemAsync(KEY, value),
};

export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) return DEFAULT_APPEARANCE;
  try {
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

export interface ThemeState extends Appearance {
  /** The mode shown (System resolved against the device). */
  mode: ThemeMode;
  /** Changes with the theme (`mode:accent`); screens are keyed by it so they rebuild. */
  revision: string;
  setPreference: (preference: ThemePreference) => void;
  setAccent: (accent: ThemeAccent) => void;
}

const ThemeContext = createContext<ThemeState>({
  ...DEFAULT_APPEARANCE,
  mode: 'dark',
  revision: 'dark:champagne',
  setPreference: () => undefined,
  setAccent: () => undefined,
});

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}

/**
 * Appearance on mobile: Obsidian (dark), Ivory (light) or System, and the accent. The choice is
 * saved on this device; "System" follows the phone's setting as it changes. Changing it updates
 * the shared colour object before rendering, and `revision` changes so screens rebuild.
 */
export function ThemeProvider({
  children,
  store = secureAppearanceStore,
}: {
  children: ReactNode;
  store?: AppearanceStore;
}) {
  const scheme = useColorScheme();
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const mode: ThemeMode =
    appearance.preference === 'system'
      ? scheme === 'light'
        ? 'light'
        : 'dark'
      : appearance.preference;

  useEffect(() => {
    let active = true;
    store.load().then(
      (raw) => {
        if (active) setAppearance(parseAppearance(raw));
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [store]);

  // Applied before the children render, so they read the new colours in this same pass.
  const revision = useMemo(() => {
    applyTheme(mode, appearance.accent);
    return `${mode}:${appearance.accent}`;
  }, [mode, appearance.accent]);

  const update = useCallback(
    (next: Appearance) => {
      setAppearance(next);
      store.save(JSON.stringify(next)).catch(() => undefined);
    },
    [store],
  );

  const value = useMemo<ThemeState>(
    () => ({
      ...appearance,
      mode,
      revision,
      setPreference: (preference) => {
        update({ ...appearance, preference });
      },
      setAccent: (accent) => {
        update({ ...appearance, accent });
      },
    }),
    [appearance, mode, revision, update],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
