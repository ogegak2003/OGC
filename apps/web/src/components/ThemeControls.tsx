import {
  ACCENT_LABELS,
  THEME_ACCENTS,
  type ThemeAccent,
  type ThemePreference,
  resolveTheme,
} from '@ogc/ui';
import { useId } from 'react';
import { useTheme } from '../theme/theme';
import { Icon, type IconName } from './Icon';
import styles from './ThemeControls.module.css';

const MODES: { value: ThemePreference; label: string; icon: IconName; hint: string }[] = [
  { value: 'dark', label: 'Obsidian', icon: 'moon', hint: 'Dark' },
  { value: 'light', label: 'Ivory', icon: 'sun', hint: 'Light' },
  { value: 'system', label: 'System', icon: 'device', hint: 'Follows this device' },
];

/**
 * Appearance choices: mode (dark, light, follow the device) and accent colour. Native radio
 * groups, so arrow keys move between options and screen readers announce the choice. Changes
 * apply instantly and are remembered on this device.
 */
export function ThemeControls({ compact = false }: { compact?: boolean }) {
  const { preference, accent, mode, setPreference, setAccent } = useTheme();
  const modeName = useId();
  const accentName = useId();
  return (
    <div className={[styles.controls, compact ? styles.compact : ''].join(' ')}>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Appearance</legend>
        <div className={styles.segments}>
          {MODES.map((option) => (
            <label key={option.value} className={styles.segment}>
              <input
                type="radio"
                name={modeName}
                value={option.value}
                checked={preference === option.value}
                onChange={() => {
                  setPreference(option.value);
                }}
              />
              <Icon name={option.icon} size={18} />
              <span>{option.label}</span>
              {compact ? null : <span className={styles.hint}>{option.hint}</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Accent</legend>
        <div className={styles.swatches}>
          {THEME_ACCENTS.map((option: ThemeAccent) => (
            <label key={option} className={styles.swatch}>
              <input
                type="radio"
                name={accentName}
                value={option}
                checked={accent === option}
                onChange={() => {
                  setAccent(option);
                }}
              />
              <span
                className={styles.dot}
                // The swatch previews the accent in the mode currently shown.
                style={{ background: resolveTheme(mode, option).accent }}
                aria-hidden="true"
              />
              <span>{ACCENT_LABELS[option]}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
