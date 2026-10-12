import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's Oxc transformer reads `experimentalDecorators` / `emitDecoratorMetadata`
  // from tsconfig.json, emitting the metadata Nest dependency injection relies on.
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://ogc:ogc@localhost:5432/ogc_test?schema=public',
      CORS_ORIGINS: 'http://localhost:5173',
    },
  },
});
