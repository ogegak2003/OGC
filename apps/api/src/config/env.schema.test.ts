import { describe, expect, it } from 'vitest';
import { isWeakSecret, validateEnv } from './env.schema.js';

const base = { DATABASE_URL: 'postgresql://user:secret-value@localhost:5432/ogc' };
/** A complete, valid production configuration (TLS to both stores, non-placeholder secrets). */
const production = {
  ...base,
  DATABASE_URL: 'postgresql://ogc_app:Vq7Hk2mXp9LsW4nR@db.internal:5432/ogc?sslmode=verify-full',
  NODE_ENV: 'production',
  WEB_APP_URL: 'https://ogc.test',
  REDIS_URL: 'rediss://:Tn8Jw3QzY6cBf1Ke@redis.internal:6379',
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

  it('defaults to calls without STUN or TURN (no external provider required)', () => {
    const env = validateEnv(base);
    expect(env.WEBRTC_STUN_URLS).toEqual([]);
    expect(env.WEBRTC_TURN_URLS).toEqual([]);
    expect(env.WEBRTC_ICE_TRANSPORT_POLICY).toBe('all');
    expect(env.CALL_RING_TIMEOUT_SECONDS).toBe(45);
  });

  it('validates ICE server URLs and requires a TURN secret with TURN servers', () => {
    expect(
      validateEnv({ ...base, WEBRTC_STUN_URLS: 'stun:a.example:3478, stuns:b.example' })
        .WEBRTC_STUN_URLS,
    ).toEqual(['stun:a.example:3478', 'stuns:b.example']);
    expect(() => validateEnv({ ...base, WEBRTC_STUN_URLS: 'https://a.example' })).toThrow(
      /WEBRTC_STUN_URLS/,
    );
    expect(() => validateEnv({ ...base, WEBRTC_TURN_URLS: 'turn:t.example' })).toThrow(
      /WEBRTC_TURN_SECRET/,
    );
    expect(() =>
      validateEnv({ ...base, WEBRTC_TURN_URLS: 'turn:t.example', WEBRTC_TURN_SECRET: 'short' }),
    ).toThrow(/WEBRTC_TURN_SECRET/);
    expect(() => validateEnv({ ...base, WEBRTC_ICE_TRANSPORT_POLICY: 'relay' })).toThrow(
      /WEBRTC_ICE_TRANSPORT_POLICY/,
    );
  });

  it('treats empty call settings as unset (as Docker Compose passes them)', () => {
    const env = validateEnv({
      ...base,
      WEBRTC_STUN_URLS: '',
      WEBRTC_TURN_URLS: '',
      WEBRTC_TURN_SECRET: '',
    });
    expect(env.WEBRTC_TURN_SECRET).toBeUndefined();
    expect(env.WEBRTC_TURN_URLS).toEqual([]);
  });

  it('never echoes the TURN secret in error messages', () => {
    const secret = 'do-not-print-this-turn-secret-value-123';
    let message = '';
    try {
      validateEnv({ ...base, WEBRTC_TURN_URLS: 'not-a-turn-url', WEBRTC_TURN_SECRET: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/WEBRTC_TURN_URLS/);
    expect(message).not.toContain(secret);
  });

  it('configures SMTP email with TLS by default and requires its settings together', () => {
    const smtp = {
      ...base,
      EMAIL_TRANSPORT: 'smtp',
      EMAIL_FROM: 'OGC <no-reply@mail.ogc.test>',
      SMTP_HOST: 'smtp.provider.test',
      SMTP_USER: 'apikey',
      SMTP_PASSWORD: 'smtp-password-value',
    };
    const env = validateEnv(smtp);
    expect(env).toMatchObject({ SMTP_PORT: 587, SMTP_SECURITY: 'starttls' });
    expect(() => validateEnv({ ...smtp, SMTP_HOST: '' })).toThrow(/SMTP_HOST/);
    expect(() => validateEnv({ ...smtp, EMAIL_FROM: undefined })).toThrow(/EMAIL_FROM/);
    expect(() => validateEnv({ ...smtp, SMTP_PASSWORD: '' })).toThrow(/SMTP_PASSWORD/);
    // Plaintext SMTP is for local mail catchers only.
    expect(validateEnv({ ...smtp, SMTP_SECURITY: 'none' }).SMTP_SECURITY).toBe('none');
    expect(() => validateEnv({ ...smtp, ...production, SMTP_SECURITY: 'none' })).toThrow(
      /SMTP_SECURITY/,
    );
    expect(validateEnv({ ...smtp, ...production, NODE_ENV: 'production' }).EMAIL_TRANSPORT).toBe(
      'smtp',
    );
  });

  it('never echoes the SMTP password in error messages', () => {
    const secret = 'do-not-print-this-smtp-password';
    let message = '';
    try {
      validateEnv({ ...base, EMAIL_TRANSPORT: 'smtp', SMTP_USER: 'u', SMTP_PASSWORD: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SMTP_HOST/);
    expect(message).not.toContain(secret);
  });

  it('bounds retention periods; audit events are kept at least a year', () => {
    expect(validateEnv(base)).toMatchObject({
      RETENTION_ENABLED: true,
      RETENTION_SESSION_DAYS: 90,
      RETENTION_TOKEN_DAYS: 7,
      AUDIT_RETENTION_DAYS: 730,
      PASSWORD_RESET_TTL_MINUTES: 30,
    });
    expect(() => validateEnv({ ...base, AUDIT_RETENTION_DAYS: '30' })).toThrow(
      /AUDIT_RETENTION_DAYS/,
    );
    expect(() => validateEnv({ ...base, RETENTION_SESSION_DAYS: '0' })).toThrow(
      /RETENTION_SESSION_DAYS/,
    );
    expect(() => validateEnv({ ...base, PASSWORD_RESET_TTL_MINUTES: '1440' })).toThrow(
      /PASSWORD_RESET_TTL_MINUTES/,
    );
    expect(validateEnv({ ...base, RETENTION_ENABLED: 'false' }).RETENTION_ENABLED).toBe(false);
  });

  it('accepts the complete production configuration', () => {
    expect(validateEnv(production)).toMatchObject({ NODE_ENV: 'production', COOKIE_SECURE: true });
  });

  it('requires TLS to PostgreSQL and Redis in production unless a private network is declared', () => {
    const plainDb = 'postgresql://ogc_app:Vq7Hk2mXp9LsW4nR@db.internal:5432/ogc';
    expect(() => validateEnv({ ...production, DATABASE_URL: plainDb })).toThrow(/DATABASE_URL/);
    for (const mode of ['disable', 'prefer', 'allow']) {
      expect(() =>
        validateEnv({ ...production, DATABASE_URL: `${plainDb}?sslmode=${mode}` }),
      ).toThrow(/DATABASE_URL/);
    }
    expect(
      validateEnv({ ...production, DATABASE_URL: plainDb, DATABASE_TLS: 'private-network' })
        .DATABASE_TLS,
    ).toBe('private-network');

    const plainRedis = 'redis://:Tn8Jw3QzY6cBf1Ke@redis:6379';
    expect(() => validateEnv({ ...production, REDIS_URL: plainRedis })).toThrow(/REDIS_URL/);
    expect(
      validateEnv({ ...production, REDIS_URL: plainRedis, REDIS_TLS: 'private-network' }).REDIS_TLS,
    ).toBe('private-network');
    expect(() => validateEnv({ ...production, DATABASE_TLS: 'off' })).toThrow(/DATABASE_TLS/);
    // Development is unaffected.
    expect(validateEnv({ ...base, REDIS_URL: plainRedis }).REDIS_TLS).toBe('required');
  });

  it('refuses missing, default and placeholder credentials in production', () => {
    const db = (password: string) =>
      `postgresql://ogc_app:${password}@db.internal:5432/ogc?sslmode=require`;
    for (const password of [
      'change-me-local-only',
      'postgres',
      'short',
      'replace-with-a-password',
    ]) {
      expect(() => validateEnv({ ...production, DATABASE_URL: db(password) })).toThrow(
        /DATABASE_URL: .*weak or placeholder/,
      );
    }
    expect(() =>
      validateEnv({
        ...production,
        DATABASE_URL: 'postgresql://ogc@db.internal/ogc?sslmode=require',
      }),
    ).toThrow(/DATABASE_URL must include a password/);
    expect(() => validateEnv({ ...production, REDIS_URL: 'rediss://redis.internal:6379' })).toThrow(
      /REDIS_URL must include a password/,
    );
    expect(() =>
      validateEnv({
        ...production,
        REDIS_URL: 'rediss://:change-me-local-redis-password@redis:6379',
      }),
    ).toThrow(/REDIS_URL: .*weak/);
    expect(() =>
      validateEnv({ ...production, METRICS_TOKEN: 'replace-with-a-long-random-metrics-token' }),
    ).toThrow(/METRICS_TOKEN/);
    expect(() =>
      validateEnv({
        ...production,
        WEBRTC_TURN_URLS: 'turn:turn.ogc.test:3478',
        WEBRTC_TURN_SECRET: 'replace-with-a-long-random-secret',
      }),
    ).toThrow(/WEBRTC_TURN_SECRET/);
    expect(() =>
      validateEnv({
        ...production,
        EMAIL_TRANSPORT: 'smtp',
        EMAIL_FROM: 'no-reply@mail.ogc.test',
        SMTP_HOST: 'smtp.ogc.test',
        SMTP_USER: 'apikey',
        SMTP_PASSWORD: 'change-me',
      }),
    ).toThrow(/SMTP_PASSWORD/);
  });

  it('never echoes a rejected production secret', () => {
    const secret = 'change-me-but-do-not-print-this';
    let message = '';
    try {
      validateEnv({
        ...production,
        DATABASE_URL: `postgresql://ogc_app:${secret}@db.internal/ogc?sslmode=require`,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain(secret);
  });

  it('exempts only the local production-like stack (https://*.localhost) from the strength rule', () => {
    const local = {
      ...production,
      WEB_APP_URL: 'https://ogc.localhost',
      DATABASE_URL: 'postgresql://ogc:change-me-local-only@postgres:5432/ogc',
      DATABASE_TLS: 'private-network',
      REDIS_URL: 'redis://:change-me-local-redis-password@redis:6379',
      REDIS_TLS: 'private-network',
    };
    expect(validateEnv(local).WEB_APP_URL).toBe('https://ogc.localhost');
    // The same values on a real domain are refused.
    expect(() => validateEnv({ ...local, WEB_APP_URL: 'https://chat.ogc.test' })).toThrow(
      /weak or placeholder/,
    );
    // Passwords are still required locally.
    expect(() => validateEnv({ ...local, REDIS_URL: 'redis://redis:6379' })).toThrow(
      /REDIS_URL must include a password/,
    );
  });

  it('forbids development storage, email and push outboxes in production', () => {
    expect(() => validateEnv({ ...production, STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER/);
    expect(validateEnv(production).STORAGE_DRIVER).toBe('disabled');
    expect(() => validateEnv({ ...production, EMAIL_TRANSPORT: 'outbox' })).toThrow(
      /EMAIL_TRANSPORT/,
    );
    expect(() => validateEnv({ ...production, PUSH_PROVIDER: 'outbox' })).toThrow(/PUSH_PROVIDER/);
  });

  it('recognises weak secrets', () => {
    expect(isWeakSecret('Vq7Hk2mXp9LsW4nR')).toBe(false);
    for (const weak of ['', 'short', 'password', 'changeme-0123456789', 'example-secret-value-1']) {
      expect(isWeakSecret(weak)).toBe(true);
    }
  });
});
