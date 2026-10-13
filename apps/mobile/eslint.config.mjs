import { defineConfig } from 'eslint/config';
import { react } from '@ogc/eslint-config/react';

export default defineConfig(
  react({ tsconfigRootDir: import.meta.dirname, browser: false }),
  { ignores: ['dist/**', '.expo/**', 'android/**', 'ios/**'] },
  {
    files: ['*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly' },
    },
  },
  {
    // Expo config plugins are loaded by Node as CommonJS.
    files: ['plugins/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Build tooling run with Node.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
);
