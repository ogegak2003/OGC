import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Local runs read TEST_DATABASE_URL from apps/api/.env; CI sets it directly.
if (existsSync('.env') && !process.env.TEST_DATABASE_URL) {
  process.loadEnvFile('.env');
}

const baseEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://localhost:5173',
  WEB_APP_URL: 'http://localhost:5173',
  EMAIL_TRANSPORT: 'disabled',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: join(tmpdir(), 'ogc-test-storage'),
  // Integration tests simulate distinct clients with X-Forwarded-For.
  TRUST_PROXY_HOPS: '1',
};

export default defineConfig({
  // Vite's Oxc transformer reads `experimentalDecorators` / `emitDecoratorMetadata`
  // from tsconfig.json, emitting the metadata Nest dependency injection relies on.
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          env: { ...baseEnv, DATABASE_URL: 'postgresql://unused@localhost:5432/unused_test' },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          // One shared database: run files sequentially for deterministic state.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: { ...baseEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' },
        },
      },
    ],
  },
});
