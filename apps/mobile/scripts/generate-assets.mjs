/**
 * Renders the OGC app icons and splash image from the OGC mark (the same
 * gold-ring mark as the web app), so native builds ship OGC branding.
 *
 * Usage (from the repository root): node apps/mobile/scripts/generate-assets.mjs
 * Uses `sharp`, already a dependency of the API.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const sharp = require('sharp');

const GOLD = '#D4AA4F';
const INK = '#0B0B0A';
const ASSETS = resolve(ROOT, 'apps/mobile/assets');

/** The mark centred in a square canvas; `scale` is the ring diameter relative to the canvas. */
function mark({ size, scale, background, color = GOLD }) {
  const c = size / 2;
  const outer = (size * scale) / 2;
  const unit = outer / 19; // the mark is drawn on a 48-unit grid with an outer radius of 19
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <circle cx="${c}" cy="${c}" r="${outer}" fill="none" stroke="${color}" stroke-width="${3.5 * unit}"/>
  <circle cx="${c}" cy="${c}" r="${11 * unit}" fill="none" stroke="${color}" stroke-width="${unit}" opacity="0.45"/>
  <circle cx="${c}" cy="${c}" r="${3.5 * unit}" fill="${color}"/>
</svg>`);
}

const outputs = [
  // iOS / legacy icon: full-bleed dark square (iOS applies its own mask).
  ['icon.png', { size: 1024, scale: 0.62, background: INK }],
  // Android adaptive icon: the system masks to the inner ~66%, so keep the mark well inside.
  ['android-icon-foreground.png', { size: 512, scale: 0.46 }],
  ['android-icon-background.png', { size: 512, scale: 0, background: INK }],
  ['android-icon-monochrome.png', { size: 432, scale: 0.46, color: '#FFFFFF' }],
  // Splash: transparent mark on the configured dark background.
  ['splash-icon.png', { size: 1024, scale: 0.5 }],
  ['favicon.png', { size: 48, scale: 0.78, background: INK }],
];

for (const [file, options] of outputs) {
  const svg =
    options.scale === 0
      ? Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${options.size}" height="${options.size}"><rect width="100%" height="100%" fill="${options.background}"/></svg>`,
        )
      : mark(options);
  await sharp(svg).png({ compressionLevel: 9 }).toFile(resolve(ASSETS, file));
  console.log(`wrote assets/${file}`);
}
