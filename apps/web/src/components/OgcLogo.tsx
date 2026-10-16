import { LOGO_SYMBOL, LOGO_WORDMARK } from '@ogc/ui';
import { useId } from 'react';

const S = LOGO_SYMBOL;

/**
 * The OGC wordmark: the ring mark as "O", then geometric "G" and "C". Drawn in the theme's
 * accent (a soft vertical blend from the highlight tone), so it stays legible in light mode and
 * follows the chosen accent. Same geometry as the mobile app and `public/ogc-logo.svg`.
 * `height` in px.
 */
export function OgcLogo({
  height = 48,
  className,
}: {
  height?: number;
  className?: string | undefined;
}) {
  const gradient = `ogc-logo-${useId().replace(/[^\w-]/g, '')}`;
  const fill = `url(#${gradient})`;
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
          <stop offset="0" stopColor="var(--ogc-color-accent-highlight)" />
          <stop offset="1" stopColor="var(--ogc-color-accent)" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={fill} strokeWidth={S.ring.stroke}>
        <circle cx={S.center} cy={S.center} r={S.ring.r} />
        <circle
          cx={S.center}
          cy={S.center}
          r={S.inner.r}
          strokeWidth={S.inner.stroke}
          opacity={S.inner.opacity}
        />
        <path d={LOGO_WORDMARK.g} />
        <path d={LOGO_WORDMARK.c} />
      </g>
      <circle cx={S.center} cy={S.center} r={S.core.r} fill={fill} />
    </svg>
  );
}
