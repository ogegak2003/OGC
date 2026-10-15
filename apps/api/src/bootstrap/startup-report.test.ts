import { describe, expect, it } from 'vitest';
import { validateEnv } from '../config/env.schema.js';
import { startupNotices } from './startup-report.js';

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://ogc_app:Vq7Hk2mXp9LsW4nR@db.internal:5432/ogc?sslmode=verify-full',
  WEB_APP_URL: 'https://ogc.test',
  REDIS_URL: 'rediss://:Tn8Jw3QzY6cBf1Ke@redis.internal:6379',
};

describe('startup notices', () => {
  it('names every missing production provider, and nothing in development', () => {
    const features = startupNotices(validateEnv(production)).map((n) => n.feature);
    expect(features).toEqual(['email', 'storage', 'push', 'calls', 'metrics']);
    expect(
      startupNotices(validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/ogc' })),
    ).toEqual([]);
  });

  it('never includes configuration values', () => {
    const text = JSON.stringify(
      startupNotices(validateEnv({ ...production, DATABASE_TLS: 'private-network' })),
    );
    expect(text).not.toContain('Vq7Hk2mXp9LsW4nR');
    expect(text).not.toContain('Tn8Jw3QzY6cBf1Ke');
    expect(text).toContain('transport');
  });
});
