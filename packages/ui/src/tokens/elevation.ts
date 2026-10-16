import type { ThemeMode } from './color.js';

/** Depth per mode: soft shadows (plus a faint top highlight in dark mode). */
export const elevations = {
  dark: {
    none: 'none',
    low: '0 1px 2px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.03)',
    medium: '0 4px 16px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
    high: '0 12px 40px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
  },
  light: {
    none: 'none',
    low: '0 1px 2px rgba(22, 23, 27, 0.08)',
    medium: '0 4px 16px rgba(22, 23, 27, 0.10)',
    high: '0 12px 40px rgba(22, 23, 27, 0.16)',
  },
} as const satisfies Record<ThemeMode, Record<string, string>>;

/** Default (dark) elevation. */
export const elevation = elevations.dark;
