/**
 * Font stacks use system fonts until a licensed brand typeface is selected
 * and self-hosted (no third-party font CDNs, for privacy and CSP).
 */
export const fontFamily = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
} as const;

/** Type scale in px (≈1.2 ratio). */
export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 22,
  '2xl': 28,
  '3xl': 34,
  '4xl': 44,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeight = {
  tight: 1.15,
  snug: 1.3,
  normal: 1.5,
} as const;

/** Letter spacing in em. The wide setting is used for OGC identities and overlines. */
export const letterSpacing = {
  tight: -0.02,
  normal: 0,
  wide: 0.08,
  identity: 0.12,
} as const;
