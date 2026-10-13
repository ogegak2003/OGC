import type { Env } from '../../config/env.schema.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface RateLimit {
  limit: number;
  ttl: number;
}

export type MessagingLimitName =
  | 'messageSend'
  | 'conversationCreate'
  | 'attachmentUpload'
  | 'reaction'
  | 'edit'
  | 'delete'
  | 'receipt'
  | 'sync'
  | 'e2ee'
  | 'typing'
  | 'presence'
  | 'socketConnect'
  | 'communityCreate'
  | 'communityManage'
  | 'invite'
  | 'inviteLinkJoin'
  | 'channelPost'
  | 'moderation'
  | 'discovery'
  | 'communityReport'
  | 'notifications';

type RateLimitKey = Extract<keyof Env, `RATE_LIMIT_${string}`>;

/** Maps validated environment values to per-account limits (ADR-029). */
export function messagingLimitsFrom(
  read: <K extends RateLimitKey>(key: K) => Env[K],
): Record<MessagingLimitName, RateLimit> {
  const env = {
    RATE_LIMIT_MESSAGE_SEND: read('RATE_LIMIT_MESSAGE_SEND'),
    RATE_LIMIT_CONVERSATION_CREATE_PER_HOUR: read('RATE_LIMIT_CONVERSATION_CREATE_PER_HOUR'),
    RATE_LIMIT_ATTACHMENT_UPLOAD_PER_HOUR: read('RATE_LIMIT_ATTACHMENT_UPLOAD_PER_HOUR'),
    RATE_LIMIT_REACTION: read('RATE_LIMIT_REACTION'),
    RATE_LIMIT_EDIT: read('RATE_LIMIT_EDIT'),
    RATE_LIMIT_DELETE: read('RATE_LIMIT_DELETE'),
    RATE_LIMIT_RECEIPT: read('RATE_LIMIT_RECEIPT'),
    RATE_LIMIT_SYNC: read('RATE_LIMIT_SYNC'),
    RATE_LIMIT_E2EE: read('RATE_LIMIT_E2EE'),
    RATE_LIMIT_TYPING: read('RATE_LIMIT_TYPING'),
    RATE_LIMIT_PRESENCE: read('RATE_LIMIT_PRESENCE'),
    RATE_LIMIT_SOCKET_CONNECT: read('RATE_LIMIT_SOCKET_CONNECT'),
    RATE_LIMIT_COMMUNITY_CREATE_PER_HOUR: read('RATE_LIMIT_COMMUNITY_CREATE_PER_HOUR'),
    RATE_LIMIT_COMMUNITY_MANAGE: read('RATE_LIMIT_COMMUNITY_MANAGE'),
    RATE_LIMIT_INVITE_PER_HOUR: read('RATE_LIMIT_INVITE_PER_HOUR'),
    RATE_LIMIT_INVITE_LINK_JOIN_PER_HOUR: read('RATE_LIMIT_INVITE_LINK_JOIN_PER_HOUR'),
    RATE_LIMIT_CHANNEL_POST: read('RATE_LIMIT_CHANNEL_POST'),
    RATE_LIMIT_MODERATION: read('RATE_LIMIT_MODERATION'),
    RATE_LIMIT_DISCOVERY: read('RATE_LIMIT_DISCOVERY'),
    RATE_LIMIT_COMMUNITY_REPORT_PER_HOUR: read('RATE_LIMIT_COMMUNITY_REPORT_PER_HOUR'),
    RATE_LIMIT_NOTIFICATIONS: read('RATE_LIMIT_NOTIFICATIONS'),
  };
  return {
    messageSend: { limit: env.RATE_LIMIT_MESSAGE_SEND, ttl: MINUTE },
    conversationCreate: { limit: env.RATE_LIMIT_CONVERSATION_CREATE_PER_HOUR, ttl: HOUR },
    attachmentUpload: { limit: env.RATE_LIMIT_ATTACHMENT_UPLOAD_PER_HOUR, ttl: HOUR },
    reaction: { limit: env.RATE_LIMIT_REACTION, ttl: MINUTE },
    edit: { limit: env.RATE_LIMIT_EDIT, ttl: MINUTE },
    delete: { limit: env.RATE_LIMIT_DELETE, ttl: MINUTE },
    receipt: { limit: env.RATE_LIMIT_RECEIPT, ttl: MINUTE },
    sync: { limit: env.RATE_LIMIT_SYNC, ttl: MINUTE },
    e2ee: { limit: env.RATE_LIMIT_E2EE, ttl: MINUTE },
    typing: { limit: env.RATE_LIMIT_TYPING, ttl: MINUTE },
    presence: { limit: env.RATE_LIMIT_PRESENCE, ttl: MINUTE },
    socketConnect: { limit: env.RATE_LIMIT_SOCKET_CONNECT, ttl: MINUTE },
    communityCreate: { limit: env.RATE_LIMIT_COMMUNITY_CREATE_PER_HOUR, ttl: HOUR },
    communityManage: { limit: env.RATE_LIMIT_COMMUNITY_MANAGE, ttl: MINUTE },
    invite: { limit: env.RATE_LIMIT_INVITE_PER_HOUR, ttl: HOUR },
    inviteLinkJoin: { limit: env.RATE_LIMIT_INVITE_LINK_JOIN_PER_HOUR, ttl: HOUR },
    channelPost: { limit: env.RATE_LIMIT_CHANNEL_POST, ttl: MINUTE },
    moderation: { limit: env.RATE_LIMIT_MODERATION, ttl: MINUTE },
    discovery: { limit: env.RATE_LIMIT_DISCOVERY, ttl: MINUTE },
    communityReport: { limit: env.RATE_LIMIT_COMMUNITY_REPORT_PER_HOUR, ttl: HOUR },
    notifications: { limit: env.RATE_LIMIT_NOTIFICATIONS, ttl: MINUTE },
  };
}

/**
 * The active limits. `@Throttle` decorators are evaluated at class-definition
 * time, before dependency injection, so they read limits lazily from here
 * (`@nestjs/throttler` accepts resolver functions). Set once at startup by
 * `RateLimitsModule` from the validated configuration.
 */
let active: Record<MessagingLimitName, RateLimit> | undefined;

export function setMessagingLimits(limits: Record<MessagingLimitName, RateLimit>): void {
  active = limits;
}

export function messagingLimit(name: MessagingLimitName): RateLimit {
  if (!active) throw new Error('Messaging rate limits are not configured');
  return active[name];
}

/** `@Throttle({ default: throttle('messageSend') })` */
export function throttle(name: MessagingLimitName): {
  limit: () => number;
  ttl: () => number;
} {
  return { limit: () => messagingLimit(name).limit, ttl: () => messagingLimit(name).ttl };
}
