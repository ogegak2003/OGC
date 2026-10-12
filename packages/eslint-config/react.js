import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { base } from './base.js';

/**
 * Config for React workspaces (web, mobile).
 * @param {{ tsconfigRootDir: string, browser?: boolean, vite?: boolean }} options
 */
export function react({ tsconfigRootDir, browser = true, vite = false }) {
  return defineConfig(
    base({ tsconfigRootDir }),
    reactHooks.configs.flat.recommended,
    vite ? reactRefresh.configs.vite : {},
    {
      languageOptions: {
        globals: browser ? { ...globals.browser } : {},
      },
    },
  );
}
