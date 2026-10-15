import { color } from './tokens/color.js';
import { elevation } from './tokens/elevation.js';
import { radius, size, space } from './tokens/layout.js';
import { duration, easing } from './tokens/motion.js';
import { fontFamily, fontSize } from './tokens/typography.js';

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function group(prefix: string, values: Record<string, string | number>, unit = ''): string[] {
  return Object.entries(values).map(([key, value]) => {
    const rendered = typeof value === 'number' ? `${value}${unit}` : value;
    return `--ogc-${prefix}-${kebab(key)}: ${rendered};`;
  });
}

/**
 * Renders the design tokens as CSS custom properties (`--ogc-*`) for web
 * clients, so styles reference tokens rather than literal values.
 */
export function toCssVariables(selector = ':root'): string {
  const declarations = [
    ...group('color', color),
    ...group('font', fontFamily),
    ...group('font-size', fontSize, 'px'),
    ...group('space', space, 'px'),
    ...group('radius', radius, 'px'),
    ...group('size', size, 'px'),
    ...group('duration', duration, 'ms'),
    ...group('easing', easing),
    ...group('elevation', elevation),
  ];
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}\n`;
}
