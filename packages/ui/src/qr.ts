import QRCode from 'qrcode';

export interface QrPath {
  /** SVG path data drawing every dark module as a 1×1 square. */
  path: string;
  /** Modules per side, excluding the quiet zone. */
  size: number;
}

/**
 * Encodes text as a QR code and returns platform-neutral SVG path data, so the
 * web (DOM `<svg>`) and mobile (`react-native-svg`) render the identical code.
 * Callers are responsible for passing only public data (see ADR-013).
 */
export function qrSvgPath(text: string): QrPath {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.modules.get(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { path, size };
}
