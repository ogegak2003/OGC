import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NotificationType, PushData, PushProviderName } from '@ogc/types';

/**
 * A push notification. Content is deliberately generic: message text is end-to-end
 * encrypted and never leaves the participants' devices, so third-party push services
 * (Apple, Google, Expo) only learn that *something* arrived (ADR-028, ADR-038). The body
 * comes from a fixed set (the type system rejects anything else); the title is "OGC", or —
 * only when the recipient chose sender previews — the sender's or group's name.
 */
export interface PushNotification {
  provider: PushProviderName;
  token: string;
  title: string;
  body: PushBody;
  data: PushData;
  /** Play a sound (off during quiet hours or when the person turned sounds off). */
  sound?: boolean;
  vibration?: boolean;
  /** Calls: deliver at high priority. */
  urgent?: boolean;
  /** Seconds the push service may keep trying an offline device. */
  ttlSeconds?: number;
}

/**
 * Fixed push texts for community notifications: never names, message text or
 * post content (ADR-036). The type system rejects anything else.
 */
export const COMMUNITY_PUSH_BODY = {
  GROUP_INVITATION: 'You have a new group invitation',
  GROUP_MEMBER_ADDED: 'You were added to a group',
  GROUP_MEMBER_REMOVED: 'Your group membership changed',
  GROUP_ROLE_CHANGED: 'Your role in a group changed',
  GROUP_DETAILS_CHANGED: 'A group was updated',
  MENTION: 'You were mentioned',
  CHANNEL_ANNOUNCEMENT: 'New announcement',
  CHANNEL_ROLE_CHANGED: 'Your role in a channel changed',
  CHANNEL_JOIN_REQUEST: 'New request to join a channel',
  CHANNEL_REQUEST_APPROVED: 'Your request to join a channel was approved',
  CHANNEL_MEMBER_REMOVED: 'Your channel membership changed',
  MODERATION_RESULT: 'A report you made was reviewed',
  INVITATION_EXPIRED: 'An invitation you sent expired',
} as const satisfies Record<NotificationType, string>;

/** Call pushes: never the caller's name or the call type. */
export type CallPushBody = 'Incoming call' | 'Missed call';
export type MessagePushBody = 'New message' | 'New group message' | 'New channel message';
export type ContactPushBody = 'New contact request' | 'Your contact request was accepted';
export type CommunityPushBody = (typeof COMMUNITY_PUSH_BODY)[NotificationType];
export type PushBody = MessagePushBody | CallPushBody | ContactPushBody | CommunityPushBody;

/** The provider's answer for one notification (same order as the input). */
export type PushResult =
  | { ok: true; ticketId?: string }
  | { ok: false; code: string; retryable: boolean; invalidToken: boolean };

/** A later delivery receipt (Expo: fetched with the ticket ID ~15 minutes after sending). */
export type PushReceipt = { ok: true } | { ok: false; code: string; invalidToken: boolean };

export abstract class PushProvider {
  abstract readonly name: string;
  /**
   * Sends notifications. Returns one result per input, in order; `undefined` means all accepted
   * (providers without per-message answers, and test doubles).
   */
  abstract send(notifications: PushNotification[]): Promise<PushResult[] | undefined>;
  /** Delivery receipts by ticket ID; providers without receipts return none. */
  receipts(_ticketIds: string[]): Promise<Map<string, PushReceipt>> {
    return Promise.resolve(new Map<string, PushReceipt>());
  }
}

export class DisabledPushProvider extends PushProvider {
  readonly name = 'disabled';
  send(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

/** Development only: writes notifications as JSON files so the flow can be inspected. */
export class OutboxPushProvider extends PushProvider {
  readonly name = 'outbox';
  private readonly dir: string;

  constructor(dir: string) {
    super();
    this.dir = resolve(dir);
  }

  async send(notifications: PushNotification[]): Promise<undefined> {
    if (notifications.length === 0) return undefined;
    await mkdir(this.dir, { recursive: true });
    const file = join(
      this.dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
    );
    // Tokens are device secrets: record only their provider and a short suffix.
    const redacted = notifications.map(({ token, ...rest }) => ({
      ...rest,
      token: `…${token.slice(-6)}`,
    }));
    await writeFile(file, JSON.stringify(redacted, null, 2), { flag: 'wx' });
    return undefined;
  }
}

/**
 * Android notification channels created by the app (apps/mobile/src/notifications). Channel
 * settings are fixed once created, so each sound/vibration combination has its own channel.
 */
export function androidChannel(
  n: Pick<PushNotification, 'sound' | 'vibration' | 'urgent'>,
): string {
  const sound = n.sound ?? true;
  const vibration = n.vibration ?? true;
  if (n.urgent && sound) return 'ogc-calls';
  if (sound && vibration) return 'ogc-alerts';
  if (sound) return 'ogc-sound';
  if (vibration) return 'ogc-vibrate';
  return 'ogc-silent';
}

/** Expo's per-message error codes: which are worth retrying and which mean the token is dead. */
export function classifyExpoError(code: string | undefined): {
  code: string;
  retryable: boolean;
  invalidToken: boolean;
} {
  switch (code) {
    case 'DeviceNotRegistered':
      return { code, retryable: false, invalidToken: true };
    case 'MessageRateExceeded':
    case 'ExpoError':
    case 'ProviderError':
      return { code, retryable: true, invalidToken: false };
    case 'MessageTooBig':
    case 'MismatchSenderId':
    case 'InvalidCredentials':
    case 'InvalidProviderToken':
      // Our payload or our credentials are wrong: retrying cannot help.
      return { code, retryable: false, invalidToken: false };
    default:
      return { code: code ?? 'Unknown', retryable: true, invalidToken: false };
  }
}

interface ExpoTicket {
  status?: string;
  id?: string;
  details?: { error?: string };
}

/**
 * Expo's push service (HTTPS API, batches of up to 100; receipts in batches of up to 1000).
 * Only EXPO tokens are sent. Tickets are checked per message, and receipts later, so dead
 * tokens are removed and temporary failures retried.
 */
export class ExpoPushProvider extends PushProvider {
  readonly name = 'expo';
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpoint = 'https://exp.host/--/api/v2/push/send',
    private readonly receiptsEndpoint = 'https://exp.host/--/api/v2/push/getReceipts',
  ) {
    super();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
    };
  }

  async send(notifications: PushNotification[]): Promise<PushResult[]> {
    const results: PushResult[] = notifications.map((n) =>
      n.provider === 'EXPO'
        ? { ok: false, code: 'NotSent', retryable: true, invalidToken: false }
        : { ok: false, code: 'UnsupportedProvider', retryable: false, invalidToken: false },
    );
    const expo = notifications
      .map((n, index) => ({ n, index }))
      .filter(({ n }) => n.provider === 'EXPO');
    for (let i = 0; i < expo.length; i += 100) {
      const batch = expo.slice(i, i + 100);
      const body = batch.map(({ n }) => ({
        to: n.token,
        title: n.title,
        body: n.body,
        data: n.data,
        ...(n.sound === false ? {} : { sound: 'default' }),
        priority: n.urgent ? 'high' : 'normal',
        channelId: androidChannel(n),
        ...(n.ttlSeconds ? { ttl: n.ttlSeconds } : {}),
      }));
      let tickets: ExpoTicket[] | undefined;
      let failure: PushResult | undefined;
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          // 429 and 5xx are temporary; other 4xx mean the request itself is wrong.
          const retryable = response.status === 429 || response.status >= 500;
          failure = {
            ok: false,
            code: `HTTP_${String(response.status)}`,
            retryable,
            invalidToken: false,
          };
          this.logger.warn({ status: response.status }, 'Expo push request failed');
        } else {
          tickets = ((await response.json()) as { data?: ExpoTicket[] }).data;
        }
      } catch (error) {
        failure = { ok: false, code: 'NETWORK', retryable: true, invalidToken: false };
        this.logger.warn(
          { error: error instanceof Error ? error.name : 'unknown' },
          'Expo push unreachable',
        );
      }
      batch.forEach(({ index }, position) => {
        if (failure) {
          results[index] = failure;
          return;
        }
        const ticket = tickets?.[position];
        if (ticket?.status === 'ok') {
          results[index] = { ok: true, ...(ticket.id ? { ticketId: ticket.id } : {}) };
        } else {
          results[index] = { ok: false, ...classifyExpoError(ticket?.details?.error) };
        }
      });
    }
    return results;
  }

  override async receipts(ticketIds: string[]): Promise<Map<string, PushReceipt>> {
    const receipts = new Map<string, PushReceipt>();
    for (let i = 0; i < ticketIds.length; i += 1000) {
      const ids = ticketIds.slice(i, i + 1000);
      try {
        const response = await this.fetchImpl(this.receiptsEndpoint, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ ids }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          this.logger.warn({ status: response.status }, 'Expo receipt request failed');
          continue;
        }
        const data = ((await response.json()) as { data?: Record<string, ExpoTicket> }).data ?? {};
        for (const [id, receipt] of Object.entries(data)) {
          if (receipt.status === 'ok') {
            receipts.set(id, { ok: true });
          } else {
            const { code, invalidToken } = classifyExpoError(receipt.details?.error);
            receipts.set(id, { ok: false, code, invalidToken });
          }
        }
      } catch (error) {
        this.logger.warn(
          { error: error instanceof Error ? error.name : 'unknown' },
          'Expo receipts unreachable',
        );
      }
    }
    return receipts;
  }
}
