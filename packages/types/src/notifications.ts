import type { NotificationType } from './community.js';

/**
 * Account-wide notification preferences (Phase 7), stored on the server so every device of
 * the account follows them. Per-conversation mute and level stay on the conversation.
 */

/** What a push may show. Message text is never pushed: messages are end-to-end encrypted. */
export const NOTIFICATION_PREVIEWS = ['GENERIC', 'SENDER'] as const;
/**
 * - `GENERIC`: "OGC — New message" (default; reveals nothing to push providers).
 * - `SENDER`: the sender's or group's name as the title ("Ada Lovelace — New message"). The
 *   name passes through Expo and Apple/Google push services.
 */
export type NotificationPreview = (typeof NOTIFICATION_PREVIEWS)[number];

export interface NotificationSettingsView {
  /** Master switch: no push notifications at all when false (the in-app center still works). */
  enabled: boolean;
  /** Direct messages. */
  messages: boolean;
  /** Group messages, mentions and group invitations/changes. */
  groups: boolean;
  /** Channel messages, announcements and channel changes. */
  channels: boolean;
  contactRequests: boolean;
  /** Incoming and missed calls. */
  calls: boolean;
  preview: NotificationPreview;
  sound: boolean;
  vibration: boolean;
  /** During quiet hours notifications arrive silently (no sound or vibration). */
  quietHours: {
    enabled: boolean;
    /** Minutes after local midnight, 0–1439. May wrap past midnight (22:00 → 07:00). */
    start: number;
    end: number;
    /** IANA time zone the hours are in, e.g. `Africa/Nairobi`. */
    timeZone: string;
  };
}

/**
 * What a tapped push tells the app to open. IDs only — the app fetches and decrypts the
 * content through its normal authenticated flow.
 */
export type PushData =
  | { type: 'message'; conversationId: string }
  | { type: 'call'; callId: string; conversationId: string }
  | { type: 'community'; notification: NotificationType }
  | { type: 'contact'; event: 'request' | 'accepted' };
