import {
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  type ThemeAccent,
  type ThemeColors,
  type ThemeMode,
  resolveTheme,
} from '@ogc/ui';

/**
 * The colours of the current theme. One object, updated in place when the theme changes, so
 * code reading `color.accent` at render time always gets the current value. Styles built from
 * it must use `themedStyles`, which rebuilds them after a change.
 */
export const color: ThemeColors = { ...resolveTheme(DEFAULT_MODE, DEFAULT_ACCENT) };

/** The call stage: always the dark theme (video reads best on black), in the current accent. */
export const stage: ThemeColors = { ...resolveTheme('dark', DEFAULT_ACCENT) };

let version = 0;
let currentMode: ThemeMode = DEFAULT_MODE;

/** Switches every themed colour. Callers re-render the screens afterwards (ThemeProvider). */
export function applyTheme(mode: ThemeMode, accent: ThemeAccent): void {
  Object.assign(color, resolveTheme(mode, accent));
  Object.assign(stage, resolveTheme('dark', accent));
  currentMode = mode;
  version += 1;
}

export function themeMode(): ThemeMode {
  return currentMode;
}

/**
 * A style sheet that follows the theme: `create` runs again on first use after a theme change.
 * Use exactly like `StyleSheet.create`: `const styles = themedStyles(() => StyleSheet.create({…}))`.
 */
export function themedStyles<T extends object>(create: () => T): T {
  let cached = create();
  let builtAt = version;
  const current = (): T => {
    if (builtAt !== version) {
      cached = create();
      builtAt = version;
    }
    return cached;
  };
  // An empty target: style objects may be frozen, and a proxy over a frozen object must keep
  // returning the original values. Styles are only ever read by key.
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(current(), key) as unknown,
    has: (_target, key) => Reflect.has(current(), key),
  });
}
