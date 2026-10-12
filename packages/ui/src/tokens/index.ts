import { color, palette } from './color.js';
import { elevation } from './elevation.js';
import { borderWidth, radius, space } from './layout.js';
import { duration, easing } from './motion.js';
import { fontFamily, fontSize, fontWeight, letterSpacing, lineHeight } from './typography.js';

export const tokens = {
  palette,
  color,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  letterSpacing,
  space,
  radius,
  borderWidth,
  duration,
  easing,
  elevation,
} as const;

export type Tokens = typeof tokens;
