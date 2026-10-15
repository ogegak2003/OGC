import type { Env } from '../config/env.schema.js';

export interface StartupNotice {
  level: 'warn' | 'log';
  feature: string;
  message: string;
}

export type StartupEnv = Pick<
  Env,
  | 'NODE_ENV'
  | 'EMAIL_TRANSPORT'
  | 'STORAGE_DRIVER'
  | 'PUSH_PROVIDER'
  | 'WEBRTC_TURN_URLS'
  | 'METRICS_TOKEN'
  | 'DATABASE_TLS'
  | 'REDIS_TLS'
>;

/**
 * What a production instance runs without, stated at startup so a missing provider is never
 * mistaken for a working one. Names features only — never configuration values.
 */
export function startupNotices(env: StartupEnv): StartupNotice[] {
  if (env.NODE_ENV !== 'production') return [];
  const notices: StartupNotice[] = [];
  if (env.EMAIL_TRANSPORT === 'disabled') {
    notices.push({
      level: 'warn',
      feature: 'email',
      message: 'No email provider: verification and password-recovery emails are not sent',
    });
  }
  if (env.STORAGE_DRIVER === 'disabled') {
    notices.push({
      level: 'warn',
      feature: 'storage',
      message: 'No object storage: avatar and attachment uploads are disabled',
    });
  }
  if (env.PUSH_PROVIDER === 'disabled') {
    notices.push({
      level: 'warn',
      feature: 'push',
      message: 'No push provider: mobile notifications are not delivered',
    });
  }
  if (env.WEBRTC_TURN_URLS.length === 0) {
    notices.push({
      level: 'warn',
      feature: 'calls',
      message: 'No TURN server: calls only connect when devices can reach each other directly',
    });
  }
  if (!env.METRICS_TOKEN) {
    notices.push({
      level: 'log',
      feature: 'metrics',
      message: 'Metrics endpoint disabled (no METRICS_TOKEN)',
    });
  }
  if (env.DATABASE_TLS === 'private-network' || env.REDIS_TLS === 'private-network') {
    notices.push({
      level: 'log',
      feature: 'transport',
      message: 'Database or Redis without TLS: declared private network (DATABASE_TLS/REDIS_TLS)',
    });
  }
  return notices;
}
