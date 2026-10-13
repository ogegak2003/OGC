import { z } from 'zod';

const perWindow = (fallback: number) =>
  z.coerce.number().int().min(1).max(100_000).default(fallback);

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/**
 * Every environment variable the API reads. Validated once at startup so the
 * process fails fast on misconfiguration instead of failing at request time.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    CORS_ORIGINS: csv.pipe(z.array(z.url())).default([]),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => /^postgres(?:ql)?:\/\//.test(value), {
        message: 'DATABASE_URL must be a postgresql:// connection string',
      }),
    /** Public URL of the web client; used to build links in emails. */
    WEB_APP_URL: z
      .url()
      .transform((value) => value.replace(/\/+$/, ''))
      .default('http://localhost:5173'),
    /** `outbox` writes emails to local files (development only); `disabled` sends nothing. */
    EMAIL_TRANSPORT: z.enum(['disabled', 'outbox']).default('disabled'),
    EMAIL_OUTBOX_DIR: z.string().min(1).default('.dev-outbox'),
    /** `local` stores media on disk (development only); `disabled` turns uploads off. */
    STORAGE_DRIVER: z.enum(['disabled', 'local']).default('disabled'),
    STORAGE_LOCAL_DIR: z.string().min(1).default('.dev-storage'),
    /**
     * Redis for state shared between API instances: rate limits, presence and
     * realtime fan-out. Optional for a single development/test instance; required in production.
     */
    REDIS_URL: z
      .string()
      .refine((value) => /^rediss?:\/\//.test(value), {
        message: 'REDIS_URL must be a redis:// or rediss:// URL',
      })
      .optional(),
    /** Bearer token for GET /api/v1/metrics. Unset = metrics endpoint disabled (404). */
    METRICS_TOKEN: z.string().min(32).max(256).optional(),
    /** `outbox` writes push notifications to local files (development only). */
    PUSH_PROVIDER: z.enum(['disabled', 'outbox', 'expo']).default('disabled'),
    PUSH_OUTBOX_DIR: z.string().min(1).default('.dev-outbox/push'),
    /** Optional Expo push access token (enhanced push security in the Expo dashboard). */
    EXPO_ACCESS_TOKEN: z.string().min(1).max(256).optional(),
    // Per-account messaging rate limits (ADR-029). Windows: per minute unless noted.
    RATE_LIMIT_MESSAGE_SEND: perWindow(60),
    RATE_LIMIT_CONVERSATION_CREATE_PER_HOUR: perWindow(30),
    RATE_LIMIT_ATTACHMENT_UPLOAD_PER_HOUR: perWindow(100),
    RATE_LIMIT_REACTION: perWindow(120),
    RATE_LIMIT_EDIT: perWindow(30),
    RATE_LIMIT_DELETE: perWindow(60),
    RATE_LIMIT_RECEIPT: perWindow(600),
    RATE_LIMIT_SYNC: perWindow(600),
    RATE_LIMIT_E2EE: perWindow(120),
    RATE_LIMIT_TYPING: perWindow(60),
    RATE_LIMIT_PRESENCE: perWindow(60),
    RATE_LIMIT_SOCKET_CONNECT: perWindow(30),
    /** Defaults to true outside development and test. Required in production. */
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'Production CORS origins must use https://',
      });
    }
    if (!env.WEB_APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_APP_URL'],
        message: 'Production WEB_APP_URL must use https://',
      });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'Cookies must be Secure in production',
      });
    }
    if (env.EMAIL_TRANSPORT === 'outbox') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_TRANSPORT'],
        message: 'The development email outbox cannot be used in production',
      });
    }
    if (!env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'Redis is required in production (shared rate limits, presence and realtime)',
      });
    }
    if (env.PUSH_PROVIDER === 'outbox') {
      ctx.addIssue({
        code: 'custom',
        path: ['PUSH_PROVIDER'],
        message: 'The development push outbox cannot be used in production',
      });
    }
    if (env.STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'Local disk storage cannot be used in production; configure object storage',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates raw environment input. Error messages list variable names and
 * problems only — never the supplied values, which may be secrets.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
