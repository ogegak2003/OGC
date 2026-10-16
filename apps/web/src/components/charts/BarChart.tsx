import { useId, useState } from 'react';
import styles from './charts.module.css';
import { niceMax } from './scale';

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour, normally a theme token such as `var(--ogc-color-accent)`. */
  color: string;
}

export interface ChartPoint {
  /** Short axis label (e.g. "Mon 14"). */
  label: string;
  /** Long label for tooltips and the data table (e.g. "Monday 14 October"). */
  longLabel: string;
  values: Record<string, number>;
}

/**
 * A stacked bar chart drawn with SVG and theme tokens. Bars start at zero (no misleading
 * baselines); every day is a focusable group whose values appear in a tooltip on hover or
 * keyboard focus; a visually hidden table carries the same data for screen readers. The chart
 * never animates heights (reduced motion is respected by CSS for the fade-in).
 */
export function BarChart({
  title,
  series,
  points,
  unit,
}: {
  title: string;
  series: ChartSeries[];
  points: ChartPoint[];
  /** Plural noun for values, e.g. "calls". */
  unit: string;
}) {
  const tableId = useId();
  const [active, setActive] = useState<number | null>(null);
  const totals = points.map((point) =>
    series.reduce((sum, s) => sum + (point.values[s.key] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const width = 100;
  const height = 60;
  const gap = points.length > 20 ? 0.6 : 1.2;
  const barWidth = points.length > 0 ? width / points.length - gap : 0;
  const ticks = [0, max / 2, max];
  const sum = totals.reduce((a, b) => a + b, 0);

  return (
    <figure className={styles.figure}>
      <div className={styles.legend} aria-hidden="true">
        {series.map((s) => (
          <span key={s.key} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className={styles.plot}>
        <div className={styles.axis} aria-hidden="true">
          {[...ticks].reverse().map((tick) => (
            <span key={tick}>{Number.isInteger(tick) ? tick : tick.toFixed(1)}</span>
          ))}
        </div>
        <div className={styles.canvas}>
          <svg
            viewBox={`0 0 ${String(width)} ${String(height)}`}
            preserveAspectRatio="none"
            className={styles.svg}
            role="img"
            aria-label={`${title}: ${String(sum)} ${unit} in total. Details in the table below.`}
            aria-describedby={tableId}
          >
            {ticks.map((tick) => {
              const y = height - (tick / max) * height;
              return (
                <line
                  key={tick}
                  x1="0"
                  x2={width}
                  y1={y}
                  y2={y}
                  className={styles.grid}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {points.map((point, index) => {
              const x = index * (barWidth + gap) + gap / 2;
              let y = height;
              return (
                <g
                  key={point.longLabel}
                  className={active === index ? styles.activeBar : undefined}
                >
                  {series.map((s) => {
                    const value = point.values[s.key] ?? 0;
                    const h = (value / max) * height;
                    y -= h;
                    return value > 0 ? (
                      <rect
                        key={s.key}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={h}
                        fill={s.color}
                        rx="0.6"
                      />
                    ) : null;
                  })}
                </g>
              );
            })}
          </svg>
          {/* Focusable hit areas (HTML, so they can carry tooltips and keyboard focus). */}
          <div className={styles.hits}>
            {points.map((point, index) => (
              <button
                key={point.longLabel}
                type="button"
                className={styles.hit}
                aria-label={`${point.longLabel}: ${series
                  .map((s) => `${String(point.values[s.key] ?? 0)} ${s.label.toLowerCase()}`)
                  .join(', ')}`}
                onMouseEnter={() => {
                  setActive(index);
                }}
                onMouseLeave={() => {
                  setActive(null);
                }}
                onFocus={() => {
                  setActive(index);
                }}
                onBlur={() => {
                  setActive(null);
                }}
              />
            ))}
          </div>
          {active !== null && points[active] ? (
            <div
              className={styles.tooltip}
              style={{ left: `${String(((active + 0.5) / points.length) * 100)}%` }}
              aria-hidden="true"
            >
              <strong>{points[active].longLabel}</strong>
              {series.map((s) => (
                <span key={s.key}>
                  <span className={styles.swatch} style={{ background: s.color }} />
                  {s.label}: {points[active]?.values[s.key] ?? 0}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.labels} aria-hidden="true">
        {points.map((point, index) => (
          <span key={point.longLabel}>
            {index % Math.ceil(points.length / 7) === 0 ? point.label : ''}
          </span>
        ))}
      </div>
      <table id={tableId} className={styles.visuallyHidden}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.longLabel}>
              <th scope="row">{point.longLabel}</th>
              {series.map((s) => (
                <td key={s.key}>{point.values[s.key] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
