import { execSync } from 'node:child_process';
import pg from 'pg';

/**
 * Prepares the disposable integration-test database: creates it if needed,
 * drops everything in it, and applies all migrations — the same path a real
 * deployment takes (`prisma migrate deploy`).
 *
 * Safety: refuses to touch any database whose name does not end in `_test`, or
 * a non-local host unless OGC_ALLOW_REMOTE_TEST_DB=true (e.g. a CI service).
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

export default async function setup(): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start PostgreSQL (`pnpm db:up`) and add it to apps/api/.env — see .env.example.',
    );
  }
  const url = new URL(raw);
  const database = url.pathname.slice(1);
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to reset "${database}": test database names must end in _test`);
  }
  if (!LOCAL_HOSTS.has(url.hostname) && process.env.OGC_ALLOW_REMOTE_TEST_DB !== 'true') {
    throw new Error(`Refusing to reset a database on non-local host "${url.hostname}"`);
  }

  const adminUrl = new URL(raw);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${database.replaceAll('"', '')}"`);
  } finally {
    await admin.end();
  }

  const testUrl = new URL(raw);
  testUrl.search = '';
  const client = new pg.Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: raw },
    stdio: 'pipe',
  });
}
