import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import { toCssVariables } from './css.js';
import { color } from './tokens/color.js';

/** WCAG 2.2 AA thresholds. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe('contrastRatio', () => {
  it('matches known reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('rejects malformed colours', () => {
    expect(() => contrastRatio('red', '#000000')).toThrow(TypeError);
  });
});

describe('colour tokens meet WCAG AA', () => {
  const surfaces = ['background', 'surface', 'surfaceRaised'] as const;
  const texts = ['textPrimary', 'textSecondary', 'textMuted', 'accent'] as const;

  it.each(surfaces)('text roles are readable on %s', (surface) => {
    for (const text of texts) {
      const ratio = contrastRatio(color[text], color[surface]);
      expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('text roles are readable on tinted backgrounds', () => {
    const pairs = [
      ['textPrimary', 'accentSubtle'],
      ['accent', 'accentSubtle'],
      ['accentHighlight', 'accentSubtle'],
      ['textSecondary', 'surfaceHover'],
      ['textPrimary', 'dangerSubtle'],
      ['danger', 'dangerSubtle'],
      ['textPrimary', 'successSubtle'],
      ['success', 'successSubtle'],
      ['textPrimary', 'warningSubtle'],
      ['textPrimary', 'infoSubtle'],
      ['accentHighlight', 'surfaceRaised'],
    ] as const;
    for (const [text, fill] of pairs) {
      const ratio = contrastRatio(color[text], color[fill]);
      expect(ratio, `${text} on ${fill}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('text on the gold accent is readable', () => {
    for (const fill of ['accent', 'accentHover', 'accentPressed'] as const) {
      const ratio = contrastRatio(color.onAccent, color[fill]);
      expect(ratio, `onAccent on ${fill}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('focus ring and status colours are distinguishable from the background', () => {
    for (const token of ['focusRing', 'success', 'warning', 'danger', 'info'] as const) {
      const ratio = contrastRatio(color[token], color.background);
      expect(ratio, token).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe('toCssVariables', () => {
  it('emits namespaced custom properties', () => {
    const css = toCssVariables();
    expect(css.startsWith(':root {')).toBe(true);
    expect(css).toContain(`--ogc-color-background: ${color.background};`);
    expect(css).toContain('--ogc-color-text-primary:');
    expect(css).toContain('--ogc-space-4: 16px;');
  });
});
