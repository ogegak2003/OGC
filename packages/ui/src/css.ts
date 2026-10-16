import {
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  THEME_ACCENTS,
  THEME_MODES,
  type ThemeAccent,
  type ThemeMode,
  resolveTheme,
} from './tokens/color.js';
import { elevations } from './tokens/elevation.js';
import { radius, size, space } from './tokens/layout.js';
import { duration, easing } from './tokens/motion.js';
import { fontFamily, fontSize } from './tokens/typography.js';

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function group(prefix: string, values: Record<string, string | number>, unit = ''): string[] {
  return Object.entries(values).map(([key, value]) => {
    const rendered = typeof value === 'number' ? `${String(value)}${unit}` : value;
    return `--ogc-${prefix}-${kebab(key)}: ${rendered};`;
  });
}

function block(selector: string, declarations: string[]): string {
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}\n`;
}

function themeDeclarations(mode: ThemeMode, accent: ThemeAccent): string[] {
  return [
    `color-scheme: ${mode};`,
    ...group('color', { ...resolveTheme(mode, accent) }),
    ...group('elevation', elevations[mode]),
  ];
}

/**
 * Renders the design tokens as CSS custom properties (`--ogc-*`) for web clients, so styles
 * reference tokens rather than literal values. The base selector carries the default theme
 * (Obsidian dark, Champagne). `[data-theme][data-accent]` selects any other mode and accent for
 * the element carrying them and everything inside it: on `<html>` it switches the whole app;
 * on a subtree (the call stage) it pins that part to one mode.
 */
export function toCssVariables(selector = ':root'): string {
  const base = block(selector, [
    ...themeDeclarations(DEFAULT_MODE, DEFAULT_ACCENT),
    ...group('font', fontFamily),
    ...group('font-size', fontSize, 'px'),
    ...group('space', space, 'px'),
    ...group('radius', radius, 'px'),
    ...group('size', size, 'px'),
    ...group('duration', duration, 'ms'),
    ...group('easing', easing),
  ]);
  const themes = THEME_MODES.flatMap((mode) =>
    THEME_ACCENTS.map((accent) =>
      block(`[data-theme="${mode}"][data-accent="${accent}"]`, themeDeclarations(mode, accent)),
    ),
  );
  return [base, ...themes].join('');
}
