import { LOGO_GOLD_STOPS, LOGO_SYMBOL, LOGO_WORDMARK } from '@ogc/ui';
import { useId } from 'react';

const S = LOGO_SYMBOL;

/**
 * The OGC wordmark in metallic gold: the globe mark as "O", then geometric "G" and "C".
 * Same geometry as the mobile app and `public/ogc-logo.svg`. `height` in px.
 */
export function OgcLogo({
  height = 48,
  className,
}: {
  height?: number;
  className?: string | undefined;
}) {
  const gradient = `ogc-gold-${useId().replace(/[^\w-]/g, '')}`;
  const gold = `url(#${gradient})`;
  return (
    <svg
      width={(height * LOGO_WORDMARK.width) / LOGO_WORDMARK.height}
      height={height}
      viewBox={`0 0 ${String(LOGO_WORDMARK.width)} ${String(LOGO_WORDMARK.height)}`}
      className={className}
      role="img"
      aria-label="OGC"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="4" x2="0" y2="44" gradientUnits="userSpaceOnUse">
          {LOGO_GOLD_STOPS.map((stop) => (
            <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </linearGradient>
      </defs>
      <g fill="none" stroke={gold} strokeWidth={S.ring.stroke}>
        <circle cx={S.center} cy={S.center} r={S.ring.r} />
        <g strokeWidth={S.inner.stroke} opacity={S.inner.opacity}>
          <circle cx={S.center} cy={S.center} r={S.inner.r} />
          <ellipse cx={S.center} cy={S.center} rx={S.meridian.rx} ry={S.meridian.ry} />
          <path
            d={`M${String(S.center - S.inner.r)} ${String(S.center)}h${String(2 * S.inner.r)}`}
          />
        </g>
        <path d={LOGO_WORDMARK.g} />
        <path d={LOGO_WORDMARK.c} />
      </g>
      <circle cx={S.center} cy={S.center} r={S.core.r} fill={gold} />
    </svg>
  );
}
