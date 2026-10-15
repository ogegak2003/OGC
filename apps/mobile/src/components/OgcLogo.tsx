import { LOGO_GOLD_STOPS, LOGO_SYMBOL, LOGO_WORDMARK } from '@ogc/ui';
import { useId } from 'react';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Stop } from 'react-native-svg';

const S = LOGO_SYMBOL;

/**
 * The OGC wordmark in metallic gold: the globe mark as "O", then geometric "G" and "C".
 * Same geometry as the web app (`@ogc/ui` logo). `height` in points.
 */
export function OgcLogo({ height = 44 }: { height?: number }) {
  const gradient = `ogc-gold-${useId().replace(/[^\w-]/g, '')}`;
  const gold = `url(#${gradient})`;
  return (
    <Svg
      width={(height * LOGO_WORDMARK.width) / LOGO_WORDMARK.height}
      height={height}
      viewBox={`0 0 ${String(LOGO_WORDMARK.width)} ${String(LOGO_WORDMARK.height)}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel="OGC"
    >
      <Defs>
        <LinearGradient id={gradient} x1="0" y1="4" x2="0" y2="44" gradientUnits="userSpaceOnUse">
          {LOGO_GOLD_STOPS.map((stop) => (
            <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </LinearGradient>
      </Defs>
      <G fill="none" stroke={gold} strokeWidth={S.ring.stroke}>
        <Circle cx={S.center} cy={S.center} r={S.ring.r} />
        <G strokeWidth={S.inner.stroke} opacity={S.inner.opacity}>
          <Circle cx={S.center} cy={S.center} r={S.inner.r} />
          <Ellipse cx={S.center} cy={S.center} rx={S.meridian.rx} ry={S.meridian.ry} />
          <Path
            d={`M${String(S.center - S.inner.r)} ${String(S.center)}h${String(2 * S.inner.r)}`}
          />
        </G>
        <Path d={LOGO_WORDMARK.g} />
        <Path d={LOGO_WORDMARK.c} />
      </G>
      <Circle cx={S.center} cy={S.center} r={S.core.r} fill={gold} />
    </Svg>
  );
}
