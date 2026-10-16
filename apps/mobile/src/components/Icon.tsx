import { ICON_STROKE, type IconName, icons } from '@ogc/ui';
import Svg, { Circle, Path } from 'react-native-svg';
import { color } from '../theme';

export type { IconName };

/**
 * An icon from the shared OGC set (`@ogc/ui` icons, identical on the web).
 * Decorative by default: the control that contains it carries the label.
 */
export function Icon({
  name,
  size = 22,
  tint = color.textSecondary,
  strokeWidth = ICON_STROKE,
}: {
  name: IconName;
  size?: number;
  tint?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {icons[name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={tint}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

/** The OGC mark: a gold ring around a quiet core — identity at the centre of a global network. */
export function OgcMark({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessible={false}>
      <Circle cx="24" cy="24" r="19" fill="none" stroke={color.accent} strokeWidth="3.5" />
      <Circle
        cx="24"
        cy="24"
        r="11"
        fill="none"
        stroke={color.accent}
        strokeWidth="1"
        opacity={0.45}
      />
      <Circle cx="24" cy="24" r="3.5" fill={color.accent} />
    </Svg>
  );
}
