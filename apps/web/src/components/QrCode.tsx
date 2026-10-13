import { qrSvgPath } from '@ogc/ui';
import { useMemo } from 'react';
import styles from './OgcQrCode.module.css';

/**
 * A QR code for a link the user chose to share (e.g. an invitation link).
 * Rendered as plain SVG paths (no HTML injection, CSP-friendly), dark on light
 * for reliable scanning. Callers decide what may be encoded.
 */
export function QrCode({
  payload,
  label,
  size = 176,
}: {
  payload: string;
  label: string;
  size?: number;
}) {
  const { path, size: modules } = useMemo(() => qrSvgPath(payload), [payload]);
  const quiet = 2;
  const box = modules + quiet * 2;
  return (
    <figure className={styles.frame}>
      <svg
        width={size}
        height={size}
        viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <rect x={-quiet} y={-quiet} width={box} height={box} fill="#F5F2EA" />
        <path d={path} fill="#0B0B0A" />
      </svg>
    </figure>
  );
}
