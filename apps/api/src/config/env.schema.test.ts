import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const base = { DATABASE_URL: 'postgresql://user:secret-value@localhost:5432/ogc' };
const production = {
  ...base,
  NODE_ENV: 'production',
  WEB_APP_URL: 'https://ogc.test',
  REDIS_URL: 'redis://redis:6379',
};

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
    expect(validateEnv({ ...production, CORS_ORIGINS: 'https://ogc.test' }).CORS_ORIGINS).toEqual([
      'https://ogc.test',
    ]);
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

  it('derives secure cookies from the environment', () => {
    expect(validateEnv(base).COOKIE_SECURE).toBe(false);
    expect(validateEnv(production).COOKIE_SECURE).toBe(true);
    expect(validateEnv({ ...base, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
  });

  it('enforces production guardrails', () => {
    expect(() => validateEnv({ ...production, WEB_APP_URL: 'http://ogc.test' })).toThrow(
      /WEB_APP_URL/,
    );
    expect(() => validateEnv({ ...production, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => validateEnv({ ...production, EMAIL_TRANSPORT: 'outbox' })).toThrow(
      /EMAIL_TRANSPORT/,
    );
  });

  it('strips trailing slashes from WEB_APP_URL', () => {
    expect(validateEnv({ ...base, WEB_APP_URL: 'http://localhost:5173/' }).WEB_APP_URL).toBe(
      'http://localhost:5173',
    );
  });

  it('requires Redis and forbids the push outbox in production', () => {
    const { REDIS_URL: _unused, ...withoutRedis } = production;
    expect(() => validateEnv(withoutRedis)).toThrow(/REDIS_URL/);
    expect(() => validateEnv({ ...production, PUSH_PROVIDER: 'outbox' })).toThrow(/PUSH_PROVIDER/);
    expect(() => validateEnv({ ...base, REDIS_URL: 'http://redis' })).toThrow(/REDIS_URL/);
  });

  it('makes messaging rate limits configurable with bounded values', () => {
    expect(validateEnv(base).RATE_LIMIT_MESSAGE_SEND).toBe(60);
    expect(validateEnv({ ...base, RATE_LIMIT_MESSAGE_SEND: '5' }).RATE_LIMIT_MESSAGE_SEND).toBe(5);
    expect(() => validateEnv({ ...base, RATE_LIMIT_MESSAGE_SEND: '0' })).toThrow(/RATE_LIMIT/);
  });

  it('requires a long metrics token when one is set', () => {
    expect(() => validateEnv({ ...base, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });
});
