import { describe, expect, it } from 'vitest';
import { isTimeZone, notificationSettingsUpdateSchema } from './notifications.js';

describe('notification settings', () => {
  it('accepts partial updates and real time zones', () => {
    expect(notificationSettingsUpdateSchema.safeParse({ messages: false }).success).toBe(true);
    expect(
      notificationSettingsUpdateSchema.safeParse({
        quietHours: { enabled: true, start: 22 * 60, end: 7 * 60, timeZone: 'Africa/Nairobi' },
      }).success,
    ).toBe(true);
    expect(isTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
  });

  it('rejects unknown fields, bad zones, out-of-range and empty quiet hours', () => {
    const bad = [
      {},
      { messages: 'yes' },
      { userId: 'someone-else' },
      { preview: 'FULL_TEXT' },
      { quietHours: { enabled: true, start: 0, end: 1440, timeZone: 'UTC' } },
      { quietHours: { enabled: true, start: 60, end: 60, timeZone: 'UTC' } },
      { quietHours: { enabled: true, start: 60, end: 120, timeZone: 'Mars/Olympus_Mons' } },
      { quietHours: { enabled: true, start: 60, end: 120, timeZone: '+03:00' } },
    ];
    for (const value of bad) {
      expect(notificationSettingsUpdateSchema.safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
  });
});
