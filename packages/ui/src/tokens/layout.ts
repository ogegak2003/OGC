/** 4px spacing grid, values in px. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = {
  none: 0,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

export const borderWidth = {
  hairline: 1,
  thick: 2,
} as const;

/** Minimum touch / pointer target and common component sizes, in px. */
export const size = {
  touch: 44,
  control: 48,
  tabBar: 64,
  appBar: 56,
  avatarSm: 32,
  avatarMd: 44,
  avatarLg: 64,
  icon: 22,
  /** Readable width for forms and single-column pages. */
  formWidth: 440,
  contentWidth: 1080,
  sidebarWidth: 264,
} as const;
