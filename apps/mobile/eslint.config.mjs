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
);
