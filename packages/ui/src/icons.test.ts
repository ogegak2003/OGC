import { describe, expect, it } from 'vitest';
import { icons } from './icons.js';

describe('icon set', () => {
  it('contains only well-formed SVG path data', () => {
    for (const [name, paths] of Object.entries(icons)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^[Mm][-\d.,\sMmLlHhVvCcSsQqAaZz]+$/);
        expect(d, name).not.toContain('NaN');
      }
    }
  });

  it('stays within the 24×24 grid', () => {
    for (const [name, paths] of Object.entries(icons)) {
      for (const d of paths) {
        // Absolute move-to coordinates must be on the canvas.
        for (const match of d.matchAll(/M(-?[\d.]+)[ ,](-?[\d.]+)/g)) {
          const [x, y] = [Number(match[1]), Number(match[2])];
          expect(x, name).toBeGreaterThanOrEqual(0);
          expect(x, name).toBeLessThanOrEqual(24);
          expect(y, name).toBeGreaterThanOrEqual(0);
          expect(y, name).toBeLessThanOrEqual(24);
        }
      }
    }
  });
});
