/**
 * Raw palette. Application code should prefer the semantic `color` tokens
 * below so the identity can evolve without touching components.
 */
export const palette = {
  gold: {
    50: '#FBF6E9',
    100: '#F4E7C2',
    200: '#EAD39A',
    300: '#DFBE70',
    400: '#D4AA4F',
    500: '#C6953A',
    600: '#A87B2E',
    700: '#866126',
    800: '#64491F',
    900: '#3F2E15',
  },
  neutral: {
    0: '#FFFFFF',
    50: '#F5F2EA',
    100: '#E7E4DC',
    200: '#CFCBC1',
    300: '#B8B3A7',
    400: '#9A958A',
    500: '#6E6A61',
    600: '#4A4842',
    700: '#3A3833',
    800: '#2A2825',
    850: '#1B1A18',
    900: '#131311',
    950: '#0B0B0A',
  },
  green: { 400: '#5DBE8A' },
  amber: { 400: '#E8B04A' },
  red: { 400: '#EF6B63' },
  blue: { 400: '#6FA8DC' },
} as const;

/** Semantic colour roles for the default (dark) OGC theme. */
export const color = {
  background: palette.neutral[950],
  surface: palette.neutral[900],
  surfaceRaised: palette.neutral[850],
  border: palette.neutral[800],
  borderStrong: palette.neutral[700],

  textPrimary: palette.neutral[50],
  textSecondary: palette.neutral[300],
  textMuted: palette.neutral[400],
  textDisabled: palette.neutral[500],

  accent: palette.gold[400],
  accentHover: palette.gold[300],
  accentPressed: palette.gold[500],
  accentSubtle: palette.gold[900],
  onAccent: palette.neutral[950],
  focusRing: palette.gold[300],

  success: palette.green[400],
  warning: palette.amber[400],
  danger: palette.red[400],
  info: palette.blue[400],
} as const;

export type ColorToken = keyof typeof color;
