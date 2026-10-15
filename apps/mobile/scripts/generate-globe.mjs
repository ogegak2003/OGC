/* global fetch */
/**
 * Renders the Earth-from-space image behind the welcome screen (web and mobile).
 *
 * Source imagery is NASA public domain (credit: NASA Earth Observatory):
 *   - Blue Marble Next Generation, July 2004, topography and bathymetry (day surface)
 *   - Black Marble 2016 (city lights)
 *   - Blue Marble cloud composite
 *
 * The globe is drawn in an orthographic projection over Africa and Europe at dawn: the sun is
 * just behind the upper-right limb, so most of the disc is night (city lights), with a lit
 * crescent, a blue atmosphere, a warm sunrise glow and subtle gold arcs between cities.
 * Corners fade into the app canvas colour, so the image blends into the page.
 *
 * Usage (from the repository root):
 *   node apps/mobile/scripts/generate-globe.mjs [texture-cache-dir]
 * Textures are downloaded once into the cache directory (default: the OS temp directory).
 * Writes apps/mobile/assets/welcome-globe.jpg and apps/web/src/assets/welcome-globe.webp.
 * Uses `sharp`, already a dependency of the API.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const sharp = require('sharp');

const NASA = 'https://eoimages.gsfc.nasa.gov/images/imagerecords';
const SOURCES = {
  day: `${NASA}/73000/73751/world.topo.bathy.200407.3x5400x2700.jpg`,
  night: `${NASA}/144000/144898/BlackMarble_2016_3km.jpg`,
  clouds: `${NASA}/57000/57747/cloud_combined_2048.jpg`,
};

const SIZE = 1400; // rendered square, px
const RADIUS = SIZE * 0.4; // globe radius, px
const CENTER_LAT = rad(16);
const CENTER_LON = rad(20);
/** Direction to the sun in view space (x right, y up, z towards the viewer): behind, upper right. */
const SUN = normalize([0.6, 0.56, -0.72]);
/** App canvas (`color.background`, #0B0B0D). */
const CANVAS = [0x0b, 0x0b, 0x0d];

const CITIES = {
  london: [51.5, -0.1],
  paris: [48.9, 2.35],
  newYork: [40.7, -74.0],
  saoPaulo: [-23.5, -46.6],
  lagos: [6.5, 3.4],
  accra: [5.6, -0.2],
  kinshasa: [-4.3, 15.3],
  nairobi: [-1.3, 36.8],
  johannesburg: [-26.2, 28.0],
  cairo: [30.0, 31.2],
  istanbul: [41.0, 29.0],
  dubai: [25.2, 55.3],
  mumbai: [19.1, 72.9],
  madrid: [40.4, -3.7],
  berlin: [52.5, 13.4],
  moscow: [55.8, 37.6],
  dakar: [14.7, -17.4],
  addisAbaba: [9.0, 38.7],
  riyadh: [24.7, 46.7],
  delhi: [28.6, 77.2],
  luanda: [-8.8, 13.2],
};
const ARCS = [
  ['london', 'newYork'],
  ['london', 'lagos'],
  ['lagos', 'saoPaulo'],
  ['lagos', 'nairobi'],
  ['nairobi', 'dubai'],
  ['dubai', 'mumbai'],
  ['cairo', 'paris'],
  ['istanbul', 'dubai'],
  ['johannesburg', 'nairobi'],
  ['kinshasa', 'johannesburg'],
  ['accra', 'london'],
  ['dakar', 'madrid'],
  ['dakar', 'saoPaulo'],
  ['berlin', 'moscow'],
  ['moscow', 'delhi'],
  ['addisAbaba', 'riyadh'],
  ['riyadh', 'delhi'],
  ['luanda', 'lagos'],
  ['cairo', 'addisAbaba'],
  ['madrid', 'berlin'],
];

function rad(deg) {
  return (deg * Math.PI) / 180;
}
function normalize(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}
function clamp(x, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, x));
}
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

const toLinear = new Float32Array(256).map((_, i) => (i / 255) ** 2.2);

async function download(cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const files = {};
  for (const [name, url] of Object.entries(SOURCES)) {
    const file = resolve(cacheDir, `${name}.jpg`);
    if (!existsSync(file)) {
      console.log(`Downloading ${url}`);
      const res = await fetch(url);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) throw new Error(`${url}: ${res.status} ${type}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    files[name] = file;
  }
  return files;
}

async function texture(file, width) {
  const { data, info } = await sharp(file, { limitInputPixels: false })
    .resize(width, width / 2, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}

/** Bilinear sample (linear light) of an equirectangular texture. */
function sample(t, lat, lon, out) {
  const u = ((((lon / (2 * Math.PI) + 0.5) % 1) + 1) % 1) * t.w - 0.5; // -180° at the left edge
  const v = (0.5 - lat / Math.PI) * t.h - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const xa = ((x0 % t.w) + t.w) % t.w;
  const xb = (xa + 1) % t.w;
  const ya = clamp(y0, 0, t.h - 1);
  const yb = clamp(y0 + 1, 0, t.h - 1);
  for (let c = 0; c < 3; c++) {
    const p = (x, y) => toLinear[t.data[(y * t.w + x) * t.c + c]];
    const top = p(xa, ya) * (1 - fx) + p(xb, ya) * fx;
    const bottom = p(xa, yb) * (1 - fx) + p(xb, yb) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/** Geographic position (radians) to view space, scaled by `altitude` (1 = surface). */
function project(lat, lon, altitude = 1) {
  const d = lon - CENTER_LON;
  const x = Math.cos(lat) * Math.sin(d);
  const y =
    Math.cos(CENTER_LAT) * Math.sin(lat) - Math.sin(CENTER_LAT) * Math.cos(lat) * Math.cos(d);
  const z =
    Math.sin(CENTER_LAT) * Math.sin(lat) + Math.cos(CENTER_LAT) * Math.cos(lat) * Math.cos(d);
  return [x * altitude, y * altitude, z * altitude];
}

/** Deterministic pseudo-random numbers, so the star field is identical on every run. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stars() {
  const field = new Float32Array(SIZE * SIZE);
  const next = random(2026);
  for (let i = 0; i < (SIZE * SIZE) / 1800; i++) {
    const x = Math.floor(next() * SIZE);
    const y = Math.floor(next() * SIZE);
    field[y * SIZE + x] = 0.02 + next() ** 6 * 0.35;
  }
  return field;
}

function render(day, night, clouds) {
  const out = Buffer.alloc(SIZE * SIZE * 3);
  /** City lights alone (sRGB), blurred and screened back on top as bloom. */
  const bloom = Buffer.alloc(SIZE * SIZE * 3);
  const starField = stars();
  const canvas = CANVAS.map((c) => toLinear[c]);
  const sun2d = normalize([SUN[0], SUN[1]]);
  const half = normalize([SUN[0], SUN[1], SUN[2] + 1]);
  const atmosphere = [0.16, 0.4, 1.0];
  const warm = [1.0, 0.52, 0.2];
  const cityTint = [1.0, 0.62, 0.24];
  const moonlight = [0.42, 0.55, 0.85];
  const d = [0, 0, 0];
  const n = [0, 0, 0];
  const cl = [0, 0, 0];

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = (px + 0.5 - SIZE / 2) / RADIUS;
      const dy = (SIZE / 2 - (py + 0.5)) / RADIUS;
      const r = Math.hypot(dx, dy);
      const col = [0, 0, 0];

      // Surface.
      const coverage = clamp((1 - r) * RADIUS + 0.5);
      if (coverage > 0) {
        const z = Math.sqrt(Math.max(0, 1 - Math.min(r, 1) ** 2));
        const nx = dx / Math.max(r, 1);
        const ny = dy / Math.max(r, 1);
        const lat = Math.asin(clamp(z * Math.sin(CENTER_LAT) + ny * Math.cos(CENTER_LAT), -1, 1));
        const lon =
          CENTER_LON + Math.atan2(nx, z * Math.cos(CENTER_LAT) - ny * Math.sin(CENTER_LAT));
        sample(day, lat, lon, d);
        sample(night, lat, lon, n);
        sample(clouds, lat, lon, cl);
        const cloud = smoothstep(0.02, 0.75, cl[0]);
        const ndl = nx * SUN[0] + ny * SUN[1] + z * SUN[2];
        const light = clamp(ndl * 1.15 + 0.06);
        const ocean = d[2] > d[0] * 1.4 && d[2] > d[1] ? 1 - cloud : 0;
        const spec =
          Math.max(0, nx * half[0] + ny * half[1] + z * half[2]) ** 70 * 0.6 * ocean * light;
        const lum = 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
        const lights = Math.max(0, lum - 0.02) ** 0.8 * 5.5 * (1 - cloud * 0.5);
        const dayLum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
        const nightSide = 1 - smoothstep(-0.22, 0.06, ndl);
        const fresnel = (1 - z) ** 2.4;
        const lit = smoothstep(-0.35, 0.45, ndl);
        const dawn = Math.exp(-((ndl / 0.05) ** 2));
        for (let c = 0; c < 3; c++) {
          const surface = d[c] * (1 - cloud * 0.85) + 0.92 * cloud * 0.85;
          let v = surface * light * 1.3 + spec;
          v += lights * cityTint[c] * nightSide;
          // Moonlit continents and clouds, so the night side reads as land rather than black.
          v += (dayLum * 0.08 + cloud * 0.035) * moonlight[c] * (1 - lit);
          const glow = lights * cityTint[c] * nightSide * coverage;
          bloom[(py * SIZE + px) * 3 + c] = Math.round(clamp(glow * 1.2) * 255);
          v = v * (1 - fresnel * 0.45) + atmosphere[c] * fresnel * (0.05 + 1.2 * lit);
          v += warm[c] * dawn * 0.07 * (0.2 + fresnel);
          col[c] = v * coverage;
        }
      }

      // Atmosphere halo and sunrise beyond the limb.
      const above = Math.max(0, r - 1);
      const facing = r > 0 ? (dx / r) * sun2d[0] + (dy / r) * sun2d[1] : 0;
      const litHalo = smoothstep(-0.7, 0.9, facing);
      const sunrise = Math.max(0, facing);
      const limbDist = Math.hypot(dx - sun2d[0], dy - sun2d[1]);
      // Sunburst: thin rays radiating from the point where the sun touches the limb.
      const rayAngle = Math.atan2(dy - sun2d[1], dx - sun2d[0]);
      const rays =
        (Math.abs(Math.cos(rayAngle * 6)) ** 40 * 0.5 +
          Math.abs(Math.cos(rayAngle * 11 + 0.7)) ** 60 * 0.3) *
        Math.exp(-limbDist / 0.12);
      for (let c = 0; c < 3; c++) {
        let halo =
          atmosphere[c] *
          (Math.exp(-above / 0.028) * 1.1 + Math.exp(-above / 0.16) * 0.22) *
          (0.32 + 0.68 * litHalo);
        halo +=
          warm[c] *
          (Math.exp(-above / 0.045) * sunrise ** 16 * 2.2 +
            Math.exp(-above / 0.3) * sunrise ** 5 * 0.3);
        halo +=
          [1, 0.86, 0.66][c] *
          (Math.exp(-limbDist / 0.018) * 2.8 + Math.exp(-limbDist / 0.11) * 0.7 + rays);
        col[c] += halo * (r > 1 ? 1 : smoothstep(0.9, 1, r));
      }

      // Stars, then fade the corners into the canvas colour.
      const i = py * SIZE + px;
      const star = r > 1.02 ? starField[i] : 0;
      const edge = Math.hypot(px + 0.5 - SIZE / 2, py + 0.5 - SIZE / 2) / (SIZE / 2);
      const fade = 1 - smoothstep(0.8, 1, edge);
      for (let c = 0; c < 3; c++) {
        const mapped = 1 - Math.exp(-(col[c] + star) * 1.15); // soft filmic roll-off
        const v = canvas[c] + (mapped - canvas[c] * mapped) * fade;
        out[i * 3 + c] = Math.round(clamp(v) ** (1 / 2.2) * 255);
      }
    }
  }
  return { out, bloom };
}

/** Gold great-circle arcs between cities, lifted off the surface; hidden behind the globe. */
function arcsSvg() {
  const toScreen = ([x, y]) =>
    `${(SIZE / 2 + x * RADIUS).toFixed(1)},${(SIZE / 2 - y * RADIUS).toFixed(1)}`;
  const visible = ([x, y, z]) => z > 0 || x * x + y * y > 1;
  const paths = [];
  const nodes = new Set();
  for (const [from, to] of ARCS) {
    const [a, b] = [CITIES[from], CITIES[to]].map(([lat, lon]) => {
      const la = rad(lat);
      const lo = rad(lon);
      return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    });
    const angle = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
    let run = [];
    for (let s = 0; s <= 64; s++) {
      const t = s / 64;
      const wa = Math.sin((1 - t) * angle) / Math.sin(angle);
      const wb = Math.sin(t * angle) / Math.sin(angle);
      const p = [0, 1, 2].map((k) => a[k] * wa + b[k] * wb);
      const lat = Math.asin(clamp(p[2], -1, 1));
      const lon = Math.atan2(p[1], p[0]);
      const point = project(lat, lon, 1 + 0.12 * angle * Math.sin(Math.PI * t));
      if (visible(point)) run.push(toScreen(point));
      else if (run.length) {
        paths.push(run);
        run = [];
      }
    }
    if (run.length > 1) paths.push(run);
    for (const city of [from, to]) {
      const [lat, lon] = CITIES[city];
      const p = project(rad(lat), rad(lon));
      if (p[2] > 0.05) nodes.add(toScreen(p));
    }
  }
  const lines = paths.map((run) => `<polyline points="${run.join(' ')}"/>`).join('');
  const dots = [...nodes]
    .map((p) => {
      const [x, y] = p.split(',');
      return `<circle cx="${x}" cy="${y}" r="4"/>`;
    })
    .join('');
  return (width, opacity) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <g fill="none" stroke="#E6C273" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}">${lines}</g>
  <g fill="#F0D48B" opacity="${Math.min(1, opacity * 1.6)}">${dots}</g>
</svg>`);
}

const cacheDir = resolve(process.argv[2] ?? resolve(tmpdir(), 'ogc-globe-textures'));
const files = await download(cacheDir);
const [day, night, clouds] = await Promise.all([
  texture(files.day, 4096),
  texture(files.night, 4096),
  texture(files.clouds, 2048),
]);

const { out: base, bloom } = render(day, night, clouds);
const raw = { raw: { width: SIZE, height: SIZE, channels: 3 } };
const cityGlow = await sharp(bloom, raw).blur(7).png().toBuffer();
const arcs = arcsSvg();
const glow = await sharp(arcs(7, 0.5)).blur(6).png().toBuffer();
const image = await sharp(base, raw)
  .composite([
    { input: cityGlow, blend: 'screen' },
    { input: glow, blend: 'screen' },
    { input: arcs(2, 0.75), blend: 'screen' },
  ])
  .png()
  .toBuffer();

const mobile = resolve(ROOT, 'apps/mobile/assets/welcome-globe.jpg');
const web = resolve(ROOT, 'apps/web/src/assets/welcome-globe.webp');
mkdirSync(resolve(web, '..'), { recursive: true });
await sharp(image).resize(1200).jpeg({ quality: 84, mozjpeg: true }).toFile(mobile);
await sharp(image).webp({ quality: 80 }).toFile(web);
console.log(`Wrote ${mobile}\nWrote ${web}`);
