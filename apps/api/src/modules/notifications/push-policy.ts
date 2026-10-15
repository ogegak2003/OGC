import type { NotificationSettingsView } from '@ogc/types';

/**
 * Push notification rules (ADR-038), free of I/O so they are unit-tested: which categories a
 * person wants, quiet hours in their own time zone, and what the title may say.
 */

export type PushCategory = 'MESSAGE' | 'GROUP' | 'CHANNEL' | 'CALL' | 'CONTACT' | 'ACCOUNT';

export const DEFAULT_SETTINGS: NotificationSettingsView = {
  enabled: true,
  messages: true,
  groups: true,
  channels: true,
  contactRequests: true,
  calls: true,
  preview: 'GENERIC',
  sound: true,
  vibration: true,
  quietHours: { enabled: false, start: 22 * 60, end: 7 * 60, timeZone: 'UTC' },
};

/** Whether this person wants pushes of this kind at all. */
export function categoryAllowed(
  settings: NotificationSettingsView,
  category: PushCategory,
): boolean {
  if (!settings.enabled) return false;
  switch (category) {
    case 'MESSAGE':
      return settings.messages;
    case 'GROUP':
      return settings.groups;
    case 'CHANNEL':
      return settings.channels;
    case 'CALL':
      return settings.calls;
    case 'CONTACT':
      return settings.contactRequests;
    case 'ACCOUNT':
      return true;
  }
}

/** Minutes after local midnight in `timeZone` (falls back to UTC for an unknown zone). */
export function localMinutes(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/**
 * Inside quiet hours: `start` inclusive, `end` exclusive, wrapping past midnight when
 * `start > end` (22:00 → 07:00 covers 23:30 and 06:59, not 07:00).
 */
export function inQuietHours(settings: NotificationSettingsView, now: Date): boolean {
  const { enabled, start, end, timeZone } = settings.quietHours;
  if (!enabled || start === end) return false;
  const minute = localMinutes(now, timeZone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Sound and vibration for one push: both off during quiet hours (it still arrives, silently). */
export function tone(
  settings: NotificationSettingsView,
  now: Date,
): { sound: boolean; vibration: boolean } {
  if (inQuietHours(settings, now)) return { sound: false, vibration: false };
  return { sound: settings.sound, vibration: settings.vibration };
}

/** Longest title a push carries (names are cut, never the fixed body). */
const TITLE_MAX = 80;

/**
 * The push title: "OGC" unless the person chose sender previews and a name is available.
 * Names are what the recipient already sees in the app; message text never appears.
 */
export function titleFor(
  settings: NotificationSettingsView,
  senderName: string | undefined,
): string {
  const name = senderName?.trim();
  if (settings.preview !== 'SENDER' || !name) return 'OGC';
  return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name;
}

/** Retry delay after `attempts` failed tries: exponential, capped, with ±20% jitter. */
export function backoffMs(
  attempts: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const capped = Math.min(baseMs * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
  return Math.round(capped * (0.8 + random() * 0.4));
}

/** Database row (or none) → the settings the rules use. */
export function settingsFrom(
  row:
    | {
        enabled: boolean;
        messages: boolean;
        groups: boolean;
        channels: boolean;
        contactRequests: boolean;
        calls: boolean;
        preview: 'GENERIC' | 'SENDER';
        sound: boolean;
        vibration: boolean;
        quietHoursEnabled: boolean;
        quietStart: number;
        quietEnd: number;
        timeZone: string;
      }
    | null
    | undefined,
): NotificationSettingsView {
  if (!row) return DEFAULT_SETTINGS;
  return {
    enabled: row.enabled,
    messages: row.messages,
    groups: row.groups,
    channels: row.channels,
    contactRequests: row.contactRequests,
    calls: row.calls,
    preview: row.preview,
    sound: row.sound,
    vibration: row.vibration,
    quietHours: {
      enabled: row.quietHoursEnabled,
      start: row.quietStart,
      end: row.quietEnd,
      timeZone: row.timeZone,
    },
  };
}
