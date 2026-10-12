import { defineConfig } from 'eslint/config';
import globals from 'globals';
import { base } from './base.js';

/**
 * Config for Node.js workspaces (API, shared libraries).
 * @param {{ tsconfigRootDir: string }} options
 */
export function node({ tsconfigRootDir }) {
  return defineConfig(base({ tsconfigRootDir }), {
    languageOptions: { globals: { ...globals.node } },
  });
}
