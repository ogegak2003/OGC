import { ICON_STROKE, type IconName, icons } from '@ogc/ui';

export type { IconName };

/**
 * An icon from the shared OGC set (`@ogc/ui`, identical on mobile). Drawn in
 * `currentColor`, so it follows the text colour of its control. Decorative:
 * the control that contains it carries the accessible name.
 */
export function Icon({
  name,
  size = 20,
  strokeWidth = ICON_STROKE,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string | undefined;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {icons[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
