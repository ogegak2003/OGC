import { randomBytes } from 'node:crypto';
import { BRIDGE_COUNTRY_REGISTRY } from '@ogc/validation';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';

/** Bridge settings, read once from validated configuration. */
export interface BridgeSettings {
  enabled: boolean;
  provider: Env['BRIDGE_PROVIDER'];
  /** Enabled countries that are also in the onboarding registry. */
  countries: string[];
  codeSecret: string;
  webhookSecret: string;
  webhookToleranceSeconds: number;
  outboxDir: string;
  maxCallSeconds: number;
  callsPerDay: number;
  concurrentCalls: number;
  dailySpendLimitMinor: number;
  blockedPrefixes: string[];
}

export const BRIDGE_SETTINGS = Symbol('BRIDGE_SETTINGS');

/** Verification codes: 6 digits, valid 10 minutes, 5 tries, resend after 60 s. */
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_MS = 60_000;
/** Codes sent to one number per day, and verifications one account may start per day. */
export const CODES_PER_NUMBER_PER_DAY = 5;
export const VERIFICATIONS_PER_ACCOUNT_PER_DAY = 10;

/** Optional secrets are typed as strings but may be unset at runtime. */
function secretOr(value: string, fallback: () => string): string {
  return value ? value : fallback();
}

export function bridgeSettings(config: ConfigService<Env, true>): BridgeSettings {
  // Development without configured secrets: random per process (never a guessable default).
  // Production refuses to start without BRIDGE_CODE_SECRET when Bridge is enabled.
  const ephemeral = () => randomBytes(32).toString('hex');
  return {
    enabled: config.get('BRIDGE_ENABLED', { infer: true }),
    provider: config.get('BRIDGE_PROVIDER', { infer: true }),
    countries: config
      .get('BRIDGE_COUNTRIES', { infer: true })
      .filter((code) => Boolean(BRIDGE_COUNTRY_REGISTRY[code])),
    codeSecret: secretOr(config.get('BRIDGE_CODE_SECRET', { infer: true }), ephemeral),
    webhookSecret: secretOr(config.get('BRIDGE_WEBHOOK_SECRET', { infer: true }), ephemeral),
    webhookToleranceSeconds: config.get('BRIDGE_WEBHOOK_TOLERANCE_SECONDS', { infer: true }),
    outboxDir: config.get('BRIDGE_OUTBOX_DIR', { infer: true }),
    maxCallSeconds: config.get('BRIDGE_MAX_CALL_SECONDS', { infer: true }),
    callsPerDay: config.get('BRIDGE_CALLS_PER_DAY', { infer: true }),
    concurrentCalls: config.get('BRIDGE_CONCURRENT_CALLS', { infer: true }),
    dailySpendLimitMinor: config.get('BRIDGE_DAILY_SPEND_LIMIT_MINOR', { infer: true }),
    blockedPrefixes: config.get('BRIDGE_BLOCKED_PREFIXES', { infer: true }),
  };
}

const MINUTE = 60_000;
/** Per-client rate limits for Bridge endpoints (`@nestjs/throttler`). */
export const BRIDGE_RATE_LIMITS = {
  read: { limit: 60, ttl: MINUTE },
  startVerification: { limit: 5, ttl: 15 * MINUTE },
  confirmVerification: { limit: 10, ttl: 15 * MINUTE },
  update: { limit: 20, ttl: MINUTE },
  eligibility: { limit: 30, ttl: MINUTE },
  startCall: { limit: 10, ttl: MINUTE },
  endCall: { limit: 30, ttl: MINUTE },
  /** Provider webhooks (per source address). */
  webhook: { limit: 600, ttl: MINUTE },
} as const;
