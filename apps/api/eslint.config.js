import { defineConfig } from 'eslint/config';
import { node } from '@ogc/eslint-config/node';

export default defineConfig(node({ tsconfigRootDir: import.meta.dirname }), {
  languageOptions: {
    parserOptions: {
      // Lets consistent-type-imports keep value imports that Nest needs
      // for constructor-injection metadata.
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
    },
  },
  rules: {
    // Nest modules are intentionally empty decorated classes.
    '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
  },
});
