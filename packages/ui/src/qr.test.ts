import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { qrSvgPath } from './qr.js';

describe('qrSvgPath', () => {
  it('produces a square module grid for an OGC identity link', () => {
    const { path, size } = qrSvgPath('ogc://id/OGC482731905');
    expect(size).toBeGreaterThanOrEqual(21);
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });

  it('draws exactly the dark modules of the encoded data', () => {
    const text = 'ogc://id/OGC306841127';
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const dark = Array.from(qr.modules.data).filter(Boolean).length;
    expect(qrSvgPath(text).path.match(/M/g)).toHaveLength(dark);
  });

  it('is deterministic', () => {
    expect(qrSvgPath('ogc://id/OGC482731905')).toEqual(qrSvgPath('ogc://id/OGC482731905'));
  });
});
