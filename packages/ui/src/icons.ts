/**
 * The OGC icon set: outline icons on a 24×24 grid, drawn with a round-capped
 * stroke (no fill). Each icon is a list of SVG path strings, so the web
 * (DOM `<svg>`) and mobile (`react-native-svg`) render identical glyphs.
 * Recommended stroke width: 1.75.
 */

function circle(cx: number, cy: number, r: number): string {
  return `M${String(cx - r)} ${String(cy)}a${String(r)} ${String(r)} 0 1 0 ${String(2 * r)} 0a${String(r)} ${String(r)} 0 1 0 ${String(-2 * r)} 0`;
}

function rect(x: number, y: number, w: number, h: number, r: number): string {
  const n = String;
  return (
    `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}` +
    `v${n(h - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}h${n(-(w - 2 * r))}` +
    `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}v${n(-(h - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}z`
  );
}

export const icons = {
  // Navigation
  home: ['M3 10.5 12 3l9 7.5', 'M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9'],
  chat: ['M12 3a9 9 0 0 0-7.8 13.5L3 21l4.5-1.2A9 9 0 1 0 12 3z'],
  contacts: [
    circle(9, 8, 3.5),
    'M2.5 20a6.5 6.5 0 0 1 13 0',
    'M16 4.6a3.5 3.5 0 0 1 0 6.8',
    'M18.5 14.2A6.5 6.5 0 0 1 21.5 20',
  ],
  community: [
    circle(12, 7.5, 3),
    circle(5.5, 10, 2.2),
    circle(18.5, 10, 2.2),
    'M6.5 20a5.5 5.5 0 0 1 11 0',
    'M2 19a3.8 3.8 0 0 1 4-3.5',
    'M22 19a3.8 3.8 0 0 0-4-3.5',
  ],
  user: [circle(12, 8, 4), 'M4 21a8 8 0 0 1 16 0'],
  search: [circle(11, 11, 7), 'm20 20-4-4'],
  bell: ['M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9z', 'M10 20.5a2 2 0 0 0 4 0'],
  settings: [
    'M4 6h9',
    'M19 6h1',
    circle(16, 6, 2.5),
    'M4 12h1',
    'M11 12h9',
    circle(8, 12, 2.5),
    'M4 18h9',
    'M19 18h1',
    circle(16, 18, 2.5),
  ],
  back: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  more: [circle(12, 5, 1), circle(12, 12, 1), circle(12, 19, 1)],
  moreHorizontal: [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
  arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'],

  // Identity
  qr: [
    rect(3, 3, 7, 7, 1.5),
    rect(14, 3, 7, 7, 1.5),
    rect(3, 14, 7, 7, 1.5),
    'M14 14h3v3h-3z',
    'M18 18h3v3h-3z',
    'M20.5 14h.5',
    'M14 20.5h.5',
  ],
  copy: [rect(8, 8, 13, 13, 2), 'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3'],
  share: ['M12 3v12', 'm7 8 5-5 5 5', 'M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'],
  userPlus: [circle(9, 8, 4), 'M2 21a7 7 0 0 1 14 0', 'M19 8v6', 'M16 11h6'],
  userCheck: [circle(9, 8, 4), 'M2 21a7 7 0 0 1 14 0', 'm16 11 2 2 4-4'],
  edit: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z', 'm13.5 6.5 4 4'],
  at: [circle(12, 12, 4), 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'],

  // Messaging
  plus: ['M12 5v14', 'M5 12h14'],
  send: ['M4 12 3 4l18 8-18 8 1-8z', 'M4 12h8'],
  mic: [rect(9, 3, 6, 11, 3), 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  paperclip: [
    'M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 6.9',
  ],
  image: [rect(3, 4, 18, 16, 2), circle(9, 10, 2), 'm21 16-5-5-9 9'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  smile: [circle(12, 12, 9), 'M8.5 14.5a4.5 4.5 0 0 0 7 0', 'M9 9.5h.01', 'M15 9.5h.01'],
  reply: ['M9 14 4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v5'],
  forward: ['m15 14 5-5-5-5', 'M20 9H10a6 6 0 0 0-6 6v5'],
  check: ['M5 12.5 10 17.5 19 7'],
  checkDouble: ['M2 12.5 7 17.5 16 7', 'm12.5 17 .5.5L22 7'],
  clock: [circle(12, 12, 9), 'M12 7v5l3 2'],
  play: ['M7 4.5v15a.5.5 0 0 0 .8.4l11-7.5a.5.5 0 0 0 0-.8l-11-7.5a.5.5 0 0 0-.8.4z'],
  pause: ['M8 5v14', 'M16 5v14'],
  stop: [rect(6, 6, 12, 12, 2)],
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'],
  trash: [
    'M4 7h16',
    'M10 11v6',
    'M14 11v6',
    'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12',
    'M9 7V4h6v3',
  ],
  inbox: ['M3 13h5l1.5 3h5l1.5-3h5', 'M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z'],
  mail: [rect(3, 5, 18, 14, 2), 'm3 7 9 6 9-6'],

  // Communities
  hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
  megaphone: ['M3 10v4a1 1 0 0 0 1 1h3l7 4V5L7 9H4a1 1 0 0 0-1 1z', 'M18 9a4 4 0 0 1 0 6'],
  pin: ['M8 3h8', 'M9.5 3v6L7 12v2h10v-2l-2.5-3V3', 'M12 14v7'],
  link: [
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1',
    'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  ],
  globe: [circle(12, 12, 9), 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],

  // Security and safety
  lock: [rect(5, 11, 14, 10, 2), 'M8 11V7a4 4 0 0 1 8 0v4'],
  shield: ['M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z'],
  shieldCheck: ['M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z', 'm9 12 2 2 4-4'],
  key: [circle(7.5, 15.5, 4.5), 'M10.7 12.3 20 3', 'm16 7 3 3', 'm14 9 2 2'],
  device: [rect(6, 2, 12, 20, 2.5), 'M11 18h2'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', circle(12, 12, 3)],
  eyeOff: [
    'M3 3l18 18',
    'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9',
    'M6.6 6.6A16.5 16.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  ban: [circle(12, 12, 9), 'M5.6 5.6l12.8 12.8'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],

  // Status
  alert: [circle(12, 12, 9), 'M12 7.5v5.5', 'M12 16.5h.01'],
  info: [circle(12, 12, 9), 'M12 11v5.5', 'M12 7.5h.01'],
  offline: [
    'M3 3l18 18',
    'M8.5 16.5a5 5 0 0 1 7 0',
    'M5 12.9a10 10 0 0 1 4.3-2.5',
    'M2 8.8a15 15 0 0 1 4.2-2.6',
    'M22 8.8a15 15 0 0 0-11-3.7',
    'M19 12.9a10 10 0 0 0-2.2-1.6',
    'M12 20h.01',
  ],
  refresh: ['M20 11a8 8 0 0 0-14.9-3', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.9 3', 'M20 20v-4h-4'],

  // Calls
  phone: [
    'M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  ],
  /** Hang up: the handset turned down. */
  phoneOff: [
    'M3.5 14.5 6 17l3.5-1.5v-3a10 10 0 0 1 5 0v3L18 17l2.5-2.5a2 2 0 0 0 0-2.8A12 12 0 0 0 3.5 11.7a2 2 0 0 0 0 2.8z',
  ],
  video: [rect(3, 6, 13, 12, 2), 'm16 10 5-3v10l-5-3'],
  videoOff: ['M3 6h10a3 3 0 0 1 3 3v1l5-3v10l-5-3v3H5a2 2 0 0 1-2-2V8', 'M2 2l20 20'],
  micOff: [
    'M9 9V6a3 3 0 0 1 6 0v5',
    'M15 14.5A3 3 0 0 1 9 12',
    'M5 11a7 7 0 0 0 11.2 5.6',
    'M19 11a7 7 0 0 1-.4 2.3',
    'M12 18v3',
    'M2 2l20 20',
  ],
  /** Switch between front and rear cameras. */
  cameraSwitch: [
    'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
    'M9 13a3 3 0 0 1 5.2-2',
    'M15 13a3 3 0 0 1-5.2 2',
    'M14.5 9.5v1.7h-1.7',
    'M9.5 16.5v-1.7h1.7',
  ],
  speaker: ['M4 9v6h4l5 4V5L8 9z', 'M16.5 8.5a5 5 0 0 1 0 7', 'M19 6a8.5 8.5 0 0 1 0 12'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof icons;

/** Stroke width the icon set is drawn for. */
export const ICON_STROKE = 1.75;
