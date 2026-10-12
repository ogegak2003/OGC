import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const base = { DATABASE_URL: 'postgresql://user:secret-value@localhost:5432/ogc' };

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      TRUST_PROXY_HOPS: 0,
    });
  });

  it('parses comma-separated CORS origins', () => {
    const env = validateEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects non-postgres database URLs', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://localhost/ogc' })).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid ports', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('requires https CORS origins in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'http://ogc.test' }),
    ).toThrow(/CORS_ORIGINS/);
    expect(
      validateEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://ogc.test' })
        .CORS_ORIGINS,
    ).toEqual(['https://ogc.test']);
  });

  it('never echoes supplied values in error messages', () => {
    const secret = 'super-secret-password';
    try {
      validateEnv({ DATABASE_URL: `mysql://user:${secret}@host/db` });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
