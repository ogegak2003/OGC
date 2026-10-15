import type { NotificationSettingsView } from '@ogc/types';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  backoffMs,
  categoryAllowed,
  inQuietHours,
  localMinutes,
  titleFor,
  tone,
} from './push-policy.js';

const quiet = (
  start: number,
  end: number,
  timeZone: string,
  enabled = true,
): NotificationSettingsView => ({
  ...DEFAULT_SETTINGS,
  quietHours: { enabled, start, end, timeZone },
});

describe('categories', () => {
  it('follows each switch, and the master switch overrides all', () => {
    expect(categoryAllowed(DEFAULT_SETTINGS, 'MESSAGE')).toBe(true);
    expect(categoryAllowed({ ...DEFAULT_SETTINGS, messages: false }, 'MESSAGE')).toBe(false);
    expect(categoryAllowed({ ...DEFAULT_SETTINGS, messages: false }, 'GROUP')).toBe(true);
    expect(categoryAllowed({ ...DEFAULT_SETTINGS, calls: false }, 'CALL')).toBe(false);
    expect(categoryAllowed({ ...DEFAULT_SETTINGS, contactRequests: false }, 'CONTACT')).toBe(false);
    for (const category of ['MESSAGE', 'GROUP', 'CHANNEL', 'CALL', 'CONTACT', 'ACCOUNT'] as const) {
      expect(categoryAllowed({ ...DEFAULT_SETTINGS, enabled: false }, category)).toBe(false);
    }
  });
});

describe('quiet hours', () => {
  it('reads the local time in the person’s own time zone', () => {
    // 21:30 UTC is 00:30 the next day in Nairobi (UTC+3) and 17:30 in New York (EDT, UTC-4).
    const at = new Date('2026-10-15T21:30:00Z');
    expect(localMinutes(at, 'UTC')).toBe(21 * 60 + 30);
    expect(localMinutes(at, 'Africa/Nairobi')).toBe(30);
    expect(localMinutes(at, 'America/New_York')).toBe(17 * 60 + 30);
  });

  it('wraps past midnight: start inclusive, end exclusive', () => {
    const settings = quiet(22 * 60, 7 * 60, 'Africa/Lagos'); // UTC+1, no DST
    expect(inQuietHours(settings, new Date('2026-10-15T20:59:00Z'))).toBe(false); // 21:59
    expect(inQuietHours(settings, new Date('2026-10-15T21:00:00Z'))).toBe(true); // 22:00
    expect(inQuietHours(settings, new Date('2026-10-15T23:30:00Z'))).toBe(true); // 00:30
    expect(inQuietHours(settings, new Date('2026-10-16T05:59:00Z'))).toBe(true); // 06:59
    expect(inQuietHours(settings, new Date('2026-10-16T06:00:00Z'))).toBe(false); // 07:00
  });

  it('handles a daytime window and daylight-saving time', () => {
    const lunch = quiet(12 * 60, 13 * 60, 'Europe/London');
    // London is UTC+1 in summer and UTC+0 in winter.
    expect(inQuietHours(lunch, new Date('2026-07-01T11:30:00Z'))).toBe(true); // 12:30 BST
    expect(inQuietHours(lunch, new Date('2026-12-01T11:30:00Z'))).toBe(false); // 11:30 GMT
    expect(inQuietHours(lunch, new Date('2026-12-01T12:30:00Z'))).toBe(true); // 12:30 GMT
  });

  it('is off when disabled, and silences rather than drops', () => {
    const night = new Date('2026-10-15T23:00:00Z');
    expect(inQuietHours(quiet(22 * 60, 7 * 60, 'UTC', false), night)).toBe(false);
    expect(tone(quiet(22 * 60, 7 * 60, 'UTC'), night)).toEqual({ sound: false, vibration: false });
    expect(tone({ ...DEFAULT_SETTINGS, vibration: false }, night)).toEqual({
      sound: true,
      vibration: false,
    });
  });
});

describe('preview titles', () => {
  it('shows only "OGC" by default, and a name only with sender previews', () => {
    expect(titleFor(DEFAULT_SETTINGS, 'Ada Lovelace')).toBe('OGC');
    expect(titleFor({ ...DEFAULT_SETTINGS, preview: 'SENDER' }, 'Ada Lovelace')).toBe(
      'Ada Lovelace',
    );
    expect(titleFor({ ...DEFAULT_SETTINGS, preview: 'SENDER' }, undefined)).toBe('OGC');
    expect(titleFor({ ...DEFAULT_SETTINGS, preview: 'SENDER' }, 'x'.repeat(200))).toHaveLength(80);
  });
});

describe('retry backoff', () => {
  it('doubles per attempt, is capped, and is jittered', () => {
    const middle = () => 0.5;
    expect(backoffMs(1, 5_000, middle)).toBe(5_000);
    expect(backoffMs(2, 5_000, middle)).toBe(10_000);
    expect(backoffMs(3, 5_000, middle)).toBe(20_000);
    expect(backoffMs(20, 5_000, middle)).toBe(300_000);
    expect(backoffMs(1, 5_000, () => 0)).toBe(4_000);
    expect(backoffMs(1, 5_000, () => 1)).toBe(6_000);
  });
});
