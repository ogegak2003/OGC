/**
 * OGC colour system. The brand palette below is the source of truth; components use the
 * semantic roles of a resolved theme (`resolveTheme`), never raw values, so a person can
 * switch between dark and light modes and accent colours and the whole app follows.
 */
export const palette = {
  /** Brand anchors. */
  obsidian: '#101114',
  charcoal: '#1B1D22',
  champagne: '#D6B46A',
  ivory: '#F4F1E8',
  emerald: '#36B889',
  coral: '#F07878',
  slate: '#858B98',
  /** Supporting steel blue (third accent, information). */
  steel: '#7FA6D8',
} as const;

export type ThemeMode = 'dark' | 'light';
export type ThemeAccent = 'champagne' | 'emerald' | 'steel';
/** What a person chooses: `system` follows the device appearance. */
export type ThemePreference = ThemeMode | 'system';

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light'];
export const THEME_ACCENTS: readonly ThemeAccent[] = ['champagne', 'emerald', 'steel'];
export const ACCENT_LABELS: Record<ThemeAccent, string> = {
  champagne: 'Champagne',
  emerald: 'Emerald',
  steel: 'Blue Steel',
};

/** Neutral roles for one mode (everything except the accent). */
interface ModeColors {
  /** App canvas. */
  background: string;
  /** Panels, lists, navigation bars. */
  surface: string;
  /** Cards, inputs, sheets — anything raised above a surface. */
  surfaceRaised: string;
  /** Hovered and pressed rows and chips. */
  surfaceHover: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDisabled: string;
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerSubtle: string;
  info: string;
  infoSubtle: string;
  /** Presence: connected. */
  online: string;
  /** Presence: away or offline. */
  offline: string;
  /** Second chart series, distinct from the accent. */
  chartSecondary: string;
  /** Chart gridlines and axes. */
  chartGrid: string;
  /** Dimmed backdrop behind dialogs and sheets. */
  scrim: string;
}

/** Accent roles for one accent in one mode. */
interface AccentColors {
  /** Primary actions, selected navigation, identity highlights, unread emphasis. */
  accent: string;
  accentHover: string;
  accentPressed: string;
  /** Lighter (dark mode) or deeper (light mode) accent for identity text. */
  accentHighlight: string;
  /** Accent-tinted background (selected rows, identity card). */
  accentSubtle: string;
  /** Border on accent-tinted backgrounds. */
  accentBorder: string;
  /** Text and icons on the accent. */
  onAccent: string;
  focusRing: string;
}

const MODES: Record<ThemeMode, ModeColors> = {
  dark: {
    background: palette.obsidian,
    surface: '#15171B',
    surfaceRaised: palette.charcoal,
    surfaceHover: '#262930',
    border: '#2A2D34',
    borderStrong: '#3B3F48',
    textPrimary: palette.ivory,
    textSecondary: '#C6C8CF',
    textMuted: '#9CA1AD',
    textDisabled: '#5F6470',
    success: palette.emerald,
    successSubtle: '#0F241C',
    warning: '#E2B456',
    warningSubtle: '#2A2213',
    danger: palette.coral,
    dangerSubtle: '#2E1719',
    info: palette.steel,
    infoSubtle: '#141F2C',
    online: palette.emerald,
    offline: palette.slate,
    chartSecondary: palette.slate,
    chartGrid: '#2A2D34',
    scrim: 'rgba(8, 9, 11, 0.72)',
  },
  light: {
    background: palette.ivory,
    surface: '#FAF8F2',
    surfaceRaised: '#FFFFFF',
    surfaceHover: '#ECE8DD',
    border: '#DDD8CB',
    borderStrong: '#C5BFB0',
    textPrimary: '#16171B',
    textSecondary: '#43464E',
    textMuted: '#5D626D',
    textDisabled: '#9A9EA6',
    success: '#1C7A58',
    successSubtle: '#DFF2E9',
    warning: '#85601A',
    warningSubtle: '#F5EAD1',
    danger: '#B23B3B',
    dangerSubtle: '#F9E2E1',
    info: '#2E5C94',
    infoSubtle: '#E2EAF5',
    online: '#1C7A58',
    offline: '#6B7180',
    chartSecondary: '#6B7180',
    chartGrid: '#DDD8CB',
    scrim: 'rgba(22, 23, 27, 0.45)',
  },
};

const ACCENTS: Record<ThemeMode, Record<ThemeAccent, AccentColors>> = {
  dark: {
    champagne: {
      accent: palette.champagne,
      accentHover: '#E2C688',
      accentPressed: '#C29F55',
      accentHighlight: '#EBD9AB',
      accentSubtle: '#241F14',
      accentBorder: '#5C4B27',
      onAccent: palette.obsidian,
      focusRing: '#E2C688',
    },
    emerald: {
      accent: palette.emerald,
      accentHover: '#52CB9D',
      accentPressed: '#2DA077',
      accentHighlight: '#93E0C1',
      accentSubtle: '#0F241C',
      accentBorder: '#1F5A43',
      onAccent: '#07130E',
      focusRing: '#52CB9D',
    },
    steel: {
      accent: palette.steel,
      accentHover: '#99B9E3',
      accentPressed: '#6A93C8',
      accentHighlight: '#BCD2EE',
      accentSubtle: '#141F2C',
      accentBorder: '#2F4766',
      onAccent: '#0B1220',
      focusRing: '#99B9E3',
    },
  },
  light: {
    champagne: {
      accent: '#82621E',
      accentHover: '#735619',
      accentPressed: '#644A15',
      accentHighlight: '#6B5018',
      accentSubtle: '#F2E8CF',
      accentBorder: '#D6BE86',
      onAccent: '#FFFFFF',
      focusRing: '#82621E',
    },
    emerald: {
      accent: '#1C7A58',
      accentHover: '#186B4D',
      accentPressed: '#145B41',
      accentHighlight: '#13583F',
      accentSubtle: '#DFF2E9',
      accentBorder: '#9CD2BA',
      onAccent: '#FFFFFF',
      focusRing: '#1C7A58',
    },
    steel: {
      accent: '#2E5C94',
      accentHover: '#284F80',
      accentPressed: '#21436C',
      accentHighlight: '#1F416A',
      accentSubtle: '#E2EAF5',
      accentBorder: '#A8BFDD',
      onAccent: '#FFFFFF',
      focusRing: '#2E5C94',
    },
  },
};

export type ThemeColors = ModeColors & AccentColors;

/** The semantic colours of one theme (mode × accent). */
export function resolveTheme(mode: ThemeMode, accent: ThemeAccent): ThemeColors {
  return { ...MODES[mode], ...ACCENTS[mode][accent] };
}

export const DEFAULT_MODE: ThemeMode = 'dark';
export const DEFAULT_ACCENT: ThemeAccent = 'champagne';

/**
 * Semantic colours of the default theme (Obsidian dark, Champagne accent). Kept as a constant
 * for code that cannot follow theme changes (static assets, tests); app UI uses the resolved
 * theme (CSS variables on the web, the theme context on mobile).
 */
export const color: ThemeColors = resolveTheme(DEFAULT_MODE, DEFAULT_ACCENT);

export type ColorToken = keyof ThemeColors;
