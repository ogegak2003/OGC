import type { OgcId } from '@ogc/types';
import { buildOgcIdLink } from '@ogc/validation';
import QRCode from 'qrcode';
import { useMemo } from 'react';
import styles from './OgcQrCode.module.css';

/**
 * QR code for an OGC identity. It encodes only the public identity link
 * (`ogc://id/OGC…`) — never tokens, credentials, or private account data.
 * Rendered as plain SVG paths (no HTML injection, CSP-friendly), dark on
 * light for reliable scanning.
 */
export function OgcQrCode({ ogcId, size = 176 }: { ogcId: OgcId; size?: number }) {
  const link = buildOgcIdLink(ogcId);
  const { path, dimension } = useMemo(() => {
    const qr = QRCode.create(link, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path: d, dimension: count };
  }, [link]);

  const quiet = 2;
  return (
    <figure className={styles.frame} data-payload={link}>
      <svg
        width={size}
        height={size}
        viewBox={`${-quiet} ${-quiet} ${dimension + quiet * 2} ${dimension + quiet * 2}`}
        role="img"
        aria-label={`QR code for ${ogcId}`}
        shapeRendering="crispEdges"
      >
        <rect
          x={-quiet}
          y={-quiet}
          width={dimension + quiet * 2}
          height={dimension + quiet * 2}
          fill="#F5F2EA"
        />
        <path d={path} fill="#0B0B0A" />
      </svg>
    </figure>
  );
}
