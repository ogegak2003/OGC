import { NOTIFICATION_PREVIEWS } from '@ogc/types';
import { z } from 'zod';

/**
 * A real IANA time zone the runtime knows, by name (`Africa/Lagos`, `UTC`). Fixed offsets such
 * as `+03:00` are refused: they ignore daylight-saving changes.
 */
export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const minuteOfDay = z.number().int().min(0).max(1439);

/**
 * `PUT /v1/notifications/settings` — a partial update. Strict: unknown fields (another user's
 * ID, server-only state) are rejected, and every value is range-checked on the server.
 */
export const notificationSettingsUpdateSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    messages: z.boolean().optional(),
    groups: z.boolean().optional(),
    channels: z.boolean().optional(),
    contactRequests: z.boolean().optional(),
    calls: z.boolean().optional(),
    preview: z.enum(NOTIFICATION_PREVIEWS).optional(),
    sound: z.boolean().optional(),
    vibration: z.boolean().optional(),
    quietHours: z
      .strictObject({
        enabled: z.boolean(),
        start: minuteOfDay,
        end: minuteOfDay,
        timeZone: z.string().refine(isTimeZone, 'Unknown time zone'),
      })
      .refine((q) => q.start !== q.end, {
        message: 'Quiet hours must start and end at different times',
        path: ['end'],
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export type NotificationSettingsUpdate = z.infer<typeof notificationSettingsUpdateSchema>;
