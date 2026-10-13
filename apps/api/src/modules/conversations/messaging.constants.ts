const HOUR = 60 * 60_000;

/** Senders can edit their messages for this long after sending. */
export const MESSAGE_EDIT_WINDOW_MS = 48 * HOUR;
/** Senders can delete a message for everyone for this long after sending. */
export const MESSAGE_DELETE_FOR_EVERYONE_WINDOW_MS = 48 * HOUR;
/** Unread counts are exact up to this value (clients show "999+"). */
export const UNREAD_COUNT_CAP = 1000;
/**
 * Conversation change cursors never move closer than this to "now", so a
 * transaction that commits late with an earlier timestamp is still picked up
 * by the next sync (duplicates are harmless; clients compare versions).
 */
export const CHANGE_FEED_SAFETY_LAG_MS = 10_000;
/**
 * Encryption devices per account in a group or encrypted channel: the newest
 * active devices are eligible. With at most 32 members this bounds the MLS tree
 * to 128 leaves (ADR-033).
 */
export const GROUP_DEVICES_PER_ACCOUNT = 4;

/** Per-account device cap in a conversation's encryption directory. */
export function devicesPerAccount(type: 'DIRECT' | 'GROUP' | 'CHANNEL'): number | undefined {
  return type === 'DIRECT' ? undefined : GROUP_DEVICES_PER_ACCOUNT;
}
