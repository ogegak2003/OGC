import type { ThemeAccent, ThemeMode, ThemePreference } from '@ogc/ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  type Appearance,
  ThemeContext,
  applyAppearance,
  loadAppearance,
  saveAppearance,
  systemMode,
} from './theme';

/**
 * Owns the appearance choice (dark, light or system; accent), saves it per browser and keeps
 * `<html data-theme data-accent>` in sync, which switches every token-based style at once.
 * With "system", it follows the device's light/dark setting as it changes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const [deviceMode, setDeviceMode] = useState<ThemeMode>(() => systemMode());
  const mode = appearance.preference === 'system' ? deviceMode : appearance.preference;

  useEffect(() => {
    applyAppearance(appearance, mode);
    saveAppearance(appearance);
  }, [appearance, mode]);

  useEffect(() => {
    if (appearance.preference !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      setDeviceMode(systemMode());
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [appearance.preference]);

  const value = useMemo(
    () => ({
      ...appearance,
      mode,
      setPreference: (preference: ThemePreference) => {
        setAppearance((current) => ({ ...current, preference }));
      },
      setAccent: (accent: ThemeAccent) => {
        setAppearance((current) => ({ ...current, accent }));
      },
    }),
    [appearance, mode],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
