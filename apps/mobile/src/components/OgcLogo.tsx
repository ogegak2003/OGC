import { LOGO_SYMBOL, LOGO_WORDMARK } from '@ogc/ui';
import { useId } from 'react';
import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { color } from '../theme';

const S = LOGO_SYMBOL;

/**
 * The OGC wordmark: the ring mark as "O", then geometric "G" and "C", in the theme accent (a
 * soft vertical blend from the highlight tone), so it reads in both modes. Same geometry as the
 * web app (`@ogc/ui` logo). `height` in points.
 */
export function OgcLogo({ height = 44 }: { height?: number }) {
  const gradient = `ogc-logo-${useId().replace(/[^\w-]/g, '')}`;
  const fill = `url(#${gradient})`;
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
          <Stop offset={0} stopColor={color.accentHighlight} />
          <Stop offset={1} stopColor={color.accent} />
        </LinearGradient>
      </Defs>
      <G fill="none" stroke={fill} strokeWidth={S.ring.stroke}>
        <Circle cx={S.center} cy={S.center} r={S.ring.r} />
        <Circle
          cx={S.center}
          cy={S.center}
          r={S.inner.r}
          strokeWidth={S.inner.stroke}
          opacity={S.inner.opacity}
        />
        <Path d={LOGO_WORDMARK.g} />
        <Path d={LOGO_WORDMARK.c} />
      </G>
      <Circle cx={S.center} cy={S.center} r={S.core.r} fill={fill} />
    </Svg>
  );
}
