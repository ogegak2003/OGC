import type { OgcId } from '@ogc/types';
import { qrSvgPath } from '@ogc/ui';
import { buildOgcIdLink } from '@ogc/validation';
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
  const { path, size: modules } = useMemo(() => qrSvgPath(link), [link]);
  const quiet = 2;
  const box = modules + quiet * 2;
  return (
    <figure className={styles.frame} data-payload={link}>
      <svg
        width={size}
        height={size}
        viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
        role="img"
        aria-label={`QR code for ${ogcId}`}
        shapeRendering="crispEdges"
      >
        <rect x={-quiet} y={-quiet} width={box} height={box} fill="#F5F3EE" />
        <path d={path} fill="#0B0B0D" />
      </svg>
    </figure>
  );
}
