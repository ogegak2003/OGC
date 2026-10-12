/** The OGC mark: a gold ring around a quiet core — identity at the centre of a global network. */
export function OgcMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="24"
        cy="24"
        r="19"
        fill="none"
        stroke="var(--ogc-color-accent)"
        strokeWidth="3.5"
      />
      <circle
        cx="24"
        cy="24"
        r="11"
        fill="none"
        stroke="var(--ogc-color-accent)"
        strokeWidth="1"
        opacity="0.45"
      />
      <circle cx="24" cy="24" r="3.5" fill="var(--ogc-color-accent)" />
    </svg>
  );
}
