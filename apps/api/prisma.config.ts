import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma no longer loads .env automatically; use Node's built-in loader for local work.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Optional here so `prisma generate` works without a database (e.g. in CI);
    // commands that touch the database fail clearly when it is missing.
    url: process.env.DATABASE_URL ?? '',
  },
});
