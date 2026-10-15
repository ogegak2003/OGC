/**
 * Raw palette. Application code should prefer the semantic `color` tokens
 * below so the identity can evolve without touching components.
 */
export const palette = {
  gold: {
    50: '#FBF5E6',
    100: '#F6E8C4',
    200: '#F0D48B',
    300: '#E6C273',
    400: '#D8AD4E',
    500: '#C29538',
    600: '#A07A2C',
    700: '#7D5F24',
    800: '#5A441B',
    900: '#2E2413',
    950: '#1C170E',
  },
  neutral: {
    0: '#FFFFFF',
    50: '#F5F3EE',
    100: '#E8E5DE',
    200: '#CFCBC2',
    300: '#B5B0A6',
    400: '#9B968C',
    500: '#6B675F',
    600: '#4A4843',
    700: '#34343A',
    750: '#2A2A2F',
    800: '#232328',
    850: '#19191D',
    900: '#121214',
    950: '#0B0B0D',
  },
  green: { 400: '#5DBE8A', 950: '#11211A' },
  amber: { 400: '#E8B04A', 950: '#241C0E' },
  red: { 400: '#EF6B63', 950: '#2A1514' },
  blue: { 400: '#6FA8DC', 950: '#111C27' },
} as const;

/** Semantic colour roles for the default (dark) OGC theme. */
export const color = {
  /** App canvas. */
  background: palette.neutral[950],
  /** Panels, lists, navigation bars. */
  surface: palette.neutral[900],
  /** Cards, inputs, sheets — anything raised above a surface. */
  surfaceRaised: palette.neutral[850],
  /** Pressed / hovered rows and chips on raised surfaces. */
  surfaceHover: palette.neutral[750],
  border: palette.neutral[800],
  borderStrong: palette.neutral[700],

  textPrimary: palette.neutral[50],
  textSecondary: palette.neutral[300],
  textMuted: palette.neutral[400],
  textDisabled: palette.neutral[500],

  /** Gold: primary actions, selected navigation, identity highlights, important states. */
  accent: palette.gold[400],
  accentHover: palette.gold[300],
  accentPressed: palette.gold[500],
  /** Champagne highlight for identity text and gradients. */
  accentHighlight: palette.gold[200],
  /** Gold-tinted background (selected rows, identity card, unread emphasis). */
  accentSubtle: palette.gold[950],
  /** Border on gold-tinted backgrounds. */
  accentBorder: palette.gold[800],
  onAccent: palette.neutral[950],
  focusRing: palette.gold[300],

  success: palette.green[400],
  successSubtle: palette.green[950],
  warning: palette.amber[400],
  warningSubtle: palette.amber[950],
  danger: palette.red[400],
  dangerSubtle: palette.red[950],
  info: palette.blue[400],
  infoSubtle: palette.blue[950],

  /** Dimmed backdrop behind dialogs and sheets. */
  scrim: 'rgba(5, 5, 6, 0.72)',
} as const;

export type ColorToken = keyof typeof color;
