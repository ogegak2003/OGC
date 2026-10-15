import { z } from 'zod';

const perWindow = (fallback: number) =>
  z.coerce.number().int().min(1).max(100_000).default(fallback);

const seconds = (fallback: number) => z.coerce.number().int().min(1).max(600).default(fallback);

/** Empty counts as unset (Compose passes `${VAR:-}` through as ''). */
const optionalString = (schema: z.ZodString) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/** Production secrets must be at least this long (random values; see deployment.md). */
export const MIN_SECRET_LENGTH = 16;
/** Obvious placeholders and well-known defaults: never accepted as production secrets. */
const PLACEHOLDER_SECRET =
  /change-?me|replace[-_ ]?(me|with)|placeholder|example|your[-_]?(password|secret)|^(password|secret|postgres|redis|ogc|admin|root|test|default)$/i;

/** True for secrets too short or obviously not random. */
export function isWeakSecret(value: string): boolean {
  return value.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRET.test(value);
}

function urlPassword(url: string): string | undefined {
  try {
    const password = new URL(url).password;
    return password ? decodeURIComponent(password) : undefined;
  } catch {
    return undefined;
  }
}

function urlParam(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The local production-like Compose stack (https://ogc.localhost) is never publicly reachable. */
function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/** PostgreSQL TLS modes that encrypt the connection (`verify-full` also checks the host). */
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

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
    /**
     * Production transport security for PostgreSQL and Redis. `required` (default): the URLs
     * must use TLS (`sslmode=require|verify-ca|verify-full`, `rediss://`). `private-network`
     * is an explicit, documented exception for a single host whose database and Redis are
     * reachable only on a private container network (docs/operations/deployment.md).
     */
    DATABASE_TLS: z.enum(['required', 'private-network']).default('required'),
    REDIS_TLS: z.enum(['required', 'private-network']).default('required'),
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
    /**
     * `smtp` sends through an SMTP provider; `outbox` writes emails to local files (development
     * only); `disabled` sends nothing, and password recovery then answers "unavailable".
     */
    EMAIL_TRANSPORT: z.enum(['disabled', 'outbox', 'smtp']).default('disabled'),
    EMAIL_OUTBOX_DIR: z.string().min(1).default('.dev-outbox'),
    /** Sender, e.g. `OGC <no-reply@mail.example.com>`. Required for `smtp`. */
    EMAIL_FROM: optionalString(z.string().min(3).max(200)),
    SMTP_HOST: optionalString(z.string().min(1).max(253)),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    /**
     * `starttls` (port 587, TLS required — never falls back to plaintext), `tls` (implicit TLS,
     * port 465), or `none` (local mail catchers only; refused in production).
     */
    SMTP_SECURITY: z.enum(['starttls', 'tls', 'none']).default('starttls'),
    SMTP_USER: optionalString(z.string().min(1).max(256)),
    /** Provider credential. A secret: never logged, never sent to clients. */
    SMTP_PASSWORD: optionalString(z.string().min(1).max(512)),
    SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    /** How long a password-reset link stays valid. */
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
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
    METRICS_TOKEN: optionalString(z.string().min(32).max(256)),
    /** `outbox` writes push notifications to local files (development only). */
    PUSH_PROVIDER: z.enum(['disabled', 'outbox', 'expo']).default('disabled'),
    PUSH_OUTBOX_DIR: z.string().min(1).default('.dev-outbox/push'),
    /** Optional Expo push access token (enhanced push security in the Expo dashboard). */
    EXPO_ACCESS_TOKEN: optionalString(z.string().min(1).max(256)),
    // Push delivery queue (Phase 7, ADR-038).
    /** How often each instance claims pending pushes (and checks receipts and retention). */
    PUSH_WORKER_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
    /** Pushes claimed per worker pass. */
    PUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    /** Tries per push before it is marked failed (temporary provider errors only). */
    PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** First retry delay; doubles per attempt (capped at 5 minutes), with jitter. */
    PUSH_RETRY_BASE_MS: z.coerce.number().int().min(10).max(600_000).default(5_000),
    /** Expo receipts are available ~15 minutes after sending. */
    PUSH_RECEIPT_DELAY_SECONDS: z.coerce.number().int().min(0).max(86_400).default(900),
    /** Delivery records (no content) are deleted after this many days. */
    PUSH_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
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
    // Groups, channels and community (Phase 4, ADR-031..036).
    RATE_LIMIT_COMMUNITY_CREATE_PER_HOUR: perWindow(20),
    RATE_LIMIT_COMMUNITY_MANAGE: perWindow(60),
    RATE_LIMIT_INVITE_PER_HOUR: perWindow(100),
    RATE_LIMIT_INVITE_LINK_JOIN_PER_HOUR: perWindow(30),
    RATE_LIMIT_CHANNEL_POST: perWindow(30),
    RATE_LIMIT_MODERATION: perWindow(60),
    RATE_LIMIT_DISCOVERY: perWindow(30),
    RATE_LIMIT_COMMUNITY_REPORT_PER_HOUR: perWindow(20),
    RATE_LIMIT_NOTIFICATIONS: perWindow(120),
    /** Push-token registrations and removals per minute per account. */
    RATE_LIMIT_PUSH_REGISTER: perWindow(20),
    // One-to-one calls (Phase 6, ADR-037).
    RATE_LIMIT_CALL_START: perWindow(10),
    /** Offers, answers, ICE candidates and camera/microphone updates, per account. */
    RATE_LIMIT_CALL_SIGNAL: perWindow(600),
    /** An unanswered call ends as MISSED after this long. */
    CALL_RING_TIMEOUT_SECONDS: seconds(45),
    /** An answered call whose media never connects ends as FAILED after this long. */
    CALL_CONNECT_TIMEOUT_SECONDS: seconds(30),
    /** A device in a call may lose its realtime connection this long before the call ends. */
    CALL_RECONNECT_GRACE_SECONDS: seconds(20),
    /** Calls still open after this long are ended (abandoned-session safety net). */
    CALL_MAX_DURATION_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(240),
    /** How often each instance checks open calls for timeouts. */
    CALL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    /** Ended calls (history metadata) are deleted after this many days. */
    CALL_HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    /** Comma-separated `stun:`/`stuns:` URLs. Empty: devices use host candidates only (same network). */
    WEBRTC_STUN_URLS: csv
      .pipe(z.array(z.string().regex(/^stuns?:[^\s,]+$/, 'must be a stun: or stuns: URL')))
      .default([]),
    /** Comma-separated `turn:`/`turns:` URLs of a TURN server using the REST-API shared secret. */
    WEBRTC_TURN_URLS: csv
      .pipe(z.array(z.string().regex(/^turns?:[^\s,]+$/, 'must be a turn: or turns: URL')))
      .default([]),
    /** coturn `static-auth-secret`: signs short-lived per-call TURN credentials. Never sent to clients. */
    // Empty counts as unset (Compose passes `${WEBRTC_TURN_SECRET:-}` through as '').
    WEBRTC_TURN_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).max(256).optional(),
    ),
    WEBRTC_TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3600),
    /** `relay` sends all media through TURN so participants never learn each other's IP address. */
    WEBRTC_ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),
    // Retention cleanup (Phase 9, docs/operations/data-retention.md).
    RETENTION_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(true),
    /** How often each instance tries to run cleanup (one instance runs at a time). */
    RETENTION_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(3_600_000),
    /** Rows deleted per statement, and statements per table per run (bounded work). */
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(10).max(10_000).default(1_000),
    RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).max(1_000).default(20),
    /** Ended (revoked or expired) sessions are deleted this many days after they ended. */
    RETENTION_SESSION_DAYS: z.coerce.number().int().min(7).max(3_650).default(90),
    /** Used or expired verification and reset tokens: deleted this many days later. */
    RETENTION_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(7),
    /** Audit events older than this are deleted. The database refuses anything under 365. */
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(365).max(3_650).default(730),
    /** Open sockets re-check their session and account status this often. */
    REALTIME_SESSION_CHECK_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
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
    if (env.WEBRTC_TURN_URLS.length > 0 && !env.WEBRTC_TURN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBRTC_TURN_SECRET'],
        message: 'WEBRTC_TURN_SECRET is required when WEBRTC_TURN_URLS is set',
      });
    }
    if (env.WEBRTC_ICE_TRANSPORT_POLICY === 'relay' && env.WEBRTC_TURN_URLS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBRTC_ICE_TRANSPORT_POLICY'],
        message: 'Relay-only calls need a TURN server (WEBRTC_TURN_URLS)',
      });
    }
    if (env.EMAIL_TRANSPORT === 'smtp') {
      for (const name of ['EMAIL_FROM', 'SMTP_HOST'] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required for smtp` });
        }
      }
      if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_PASSWORD'],
          message: 'SMTP_USER and SMTP_PASSWORD must be set together',
        });
      }
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.EMAIL_TRANSPORT === 'smtp' && env.SMTP_SECURITY === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_SECURITY'],
        message: 'Production email must use TLS (starttls or tls)',
      });
    }
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

    // Transport security to the database and Redis.
    const sslmode = urlParam(env.DATABASE_URL, 'sslmode');
    if (env.DATABASE_TLS === 'required' && !(sslmode && TLS_SSLMODES.has(sslmode))) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'Production DATABASE_URL must use TLS (sslmode=require, verify-ca or verify-full), ' +
          'or set DATABASE_TLS=private-network for a private container network',
      });
    }
    if (env.REDIS_URL && env.REDIS_TLS === 'required' && !env.REDIS_URL.startsWith('rediss://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message:
          'Production REDIS_URL must use TLS (rediss://), ' +
          'or set REDIS_TLS=private-network for a private container network',
      });
    }

    // No default, placeholder or missing credentials. (The local production-like stack at
    // https://*.localhost uses local-only values and is exempt; it is never publicly reachable.)
    const local = isLocalhostUrl(env.WEB_APP_URL);
    const secrets: [string, string | undefined, boolean][] = [
      ['DATABASE_URL', urlPassword(env.DATABASE_URL), true],
      ['REDIS_URL', env.REDIS_URL ? urlPassword(env.REDIS_URL) : '', true],
      ['SMTP_PASSWORD', env.SMTP_PASSWORD, false],
      ['METRICS_TOKEN', env.METRICS_TOKEN, false],
      ['WEBRTC_TURN_SECRET', env.WEBRTC_TURN_SECRET, false],
    ];
    for (const [name, value, required] of secrets) {
      if (value === '') continue; // Redis not configured: reported above.
      if (value === undefined) {
        if (required) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: `Production ${name} must include a password`,
          });
        }
        continue;
      }
      if (!local && isWeakSecret(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `Production ${name} uses a weak or placeholder secret (at least ${String(MIN_SECRET_LENGTH)} random characters required)`,
        });
      }
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
