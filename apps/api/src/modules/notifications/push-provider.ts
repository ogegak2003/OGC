import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NotificationType, PushProviderName } from '@ogc/types';

/**
 * A push notification. Content is deliberately generic: message text is
 * end-to-end encrypted and never leaves the participants' devices, so
 * third-party push services (Apple, Google, Expo) only learn that *something*
 * arrived in a conversation (ADR-028).
 */
export interface PushNotification {
  provider: PushProviderName;
  token: string;
  title: 'OGC';
  body: 'New message' | CommunityPushBody;
  data:
    | { type: 'message'; conversationId: string }
    | { type: 'community'; notification: NotificationType };
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

export type CommunityPushBody = (typeof COMMUNITY_PUSH_BODY)[NotificationType];

export abstract class PushProvider {
  abstract readonly name: string;
  abstract send(notifications: PushNotification[]): Promise<void>;
}

export class DisabledPushProvider extends PushProvider {
  readonly name = 'disabled';
  send(): Promise<void> {
    return Promise.resolve();
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

  async send(notifications: PushNotification[]): Promise<void> {
    if (notifications.length === 0) return;
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
  }
}

/** Expo's push service (HTTPS API; batches of up to 100). Only EXPO tokens are sent. */
export class ExpoPushProvider extends PushProvider {
  readonly name = 'expo';
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpoint = 'https://exp.host/--/api/v2/push/send',
  ) {
    super();
  }

  async send(notifications: PushNotification[]): Promise<void> {
    const expo = notifications.filter((n) => n.provider === 'EXPO');
    for (let i = 0; i < expo.length; i += 100) {
      const batch = expo.slice(i, i + 100).map((n) => ({
        to: n.token,
        title: n.title,
        body: n.body,
        data: n.data,
        sound: 'default',
        priority: 'high',
      }));
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Expo push request failed');
      }
    }
  }
}
