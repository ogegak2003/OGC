/**
 * The OGC logo, as platform-neutral geometry so the web (DOM `<svg>`) and mobile
 * (`react-native-svg`) draw the same lockup.
 *
 * The symbol is the OGC mark — a ring around a quiet core, with a faint inner ring: identity
 * at the centre of a conversation. In the wordmark the symbol is the "O"; "G" and "C" are
 * monoline arcs with the same radius and stroke weight as the ring, so the three letters read
 * as one geometric family. (Phase 11 removed the earlier meridian and equator: OGC no longer
 * uses globe imagery.)
 */

/** The symbol's grid (48 × 48) and ring; matches the original mark. */
export const LOGO_SYMBOL = {
  size: 48,
  center: 24,
  ring: { r: 19, stroke: 3.5 },
  inner: { r: 11, stroke: 1, opacity: 0.45 },
  core: { r: 3.5 },
} as const;

const R = LOGO_SYMBOL.ring.r;
/** Half-angle of the opening on the right of "G" and "C". */
const OPENING = (42 * Math.PI) / 180;
/** Distance between letter centres: two outer radii plus a gap of half a ring. */
const PITCH = 2 * (R + LOGO_SYMBOL.ring.stroke / 2) + 8.5;

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function openArc(cx: number, cy: number, endAngle: number): string {
  const sx = cx + R * Math.cos(OPENING);
  const sy = cy - R * Math.sin(OPENING);
  const ex = cx + R * Math.cos(endAngle);
  const ey = cy + R * Math.sin(endAngle);
  return `M${n(sx)} ${n(sy)}A${n(R)} ${n(R)} 0 1 0 ${n(ex)} ${n(ey)}`;
}

const gx = LOGO_SYMBOL.center + PITCH;
const cx = LOGO_SYMBOL.center + 2 * PITCH;
const cy = LOGO_SYMBOL.center;

/** The wordmark: the symbol as "O", then "G" and "C" (stroke paths on the symbol's grid). */
export const LOGO_WORDMARK = {
  width: Math.ceil(cx + R + LOGO_SYMBOL.ring.stroke),
  height: LOGO_SYMBOL.size,
  /** "G": an open arc down to the right-hand side, then a bar towards the centre. */
  g: `${openArc(gx, cy, 0)}H${n(gx + 4)}`,
  /** "C": an open arc. */
  c: openArc(cx, cy, OPENING),
} as const;

export const LOGO_TAGLINE = 'PRIVATE COMMUNICATION, EVERYWHERE';

/** Champagne, top to bottom (y 4 → 44 on the 48 grid), for static assets; apps use theme colours. */
export const LOGO_GOLD_STOPS = [
  { offset: 0, color: '#EBD9AB' },
  { offset: 0.5, color: '#D6B46A' },
  { offset: 1, color: '#B8964F' },
] as const;
