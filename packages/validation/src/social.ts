import type { OgcId } from '@ogc/types';
import { z } from 'zod';
import { displayNameSchema } from './auth.js';
import { normalizeOgcId } from './ogc-id.js';

export const BIO_MAX_LENGTH = 280;
export const REPORT_DESCRIPTION_MAX_LENGTH = 1000;
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;

/** Control characters other than line feed. */
const CONTROL_EXCEPT_NEWLINE = /(?!\n)\p{Cc}/u;

/** Accepts an OGC ID as people type it (`ogc 482 731 905`) and yields the canonical form. */
export const ogcIdInputSchema = z
  .string()
  .max(32)
  .transform((value, ctx): OgcId => {
    const id = normalizeOgcId(value);
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid OGC ID, e.g. OGC 482 731 905' });
      return z.NEVER;
    }
    return id;
  });

export const bioSchema = z
  .string()
  .transform((value) =>
    value
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
  .pipe(
    z
      .string()
      .max(BIO_MAX_LENGTH, `Use at most ${BIO_MAX_LENGTH} characters`)
      .refine((value) => !CONTROL_EXCEPT_NEWLINE.test(value), {
        message: 'Remove unsupported characters',
      }),
  );

export const PROFILE_VISIBILITIES = ['EVERYONE', 'CONTACTS'] as const;
export const CONTACT_REQUEST_POLICIES = ['EVERYONE', 'NOBODY'] as const;

export const privacySettingsUpdateSchema = z
  .strictObject({
    profileVisibility: z.enum(PROFILE_VISIBILITIES).optional(),
    discoverable: z.boolean().optional(),
    contactRequests: z.enum(CONTACT_REQUEST_POLICIES).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Provide at least one privacy setting',
  });

/** PATCH /profile — every field optional; `bio: null` or `""` clears the bio. */
export const updateProfileRequestSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    bio: z.union([bioSchema, z.null()]).optional(),
    privacy: privacySettingsUpdateSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  });

export const contactRequestSchema = z.strictObject({ ogcId: ogcIdInputSchema });

export const REPORT_CATEGORIES = [
  'SPAM',
  'HARASSMENT',
  'IMPERSONATION',
  'INAPPROPRIATE_CONTENT',
  'SCAM_OR_FRAUD',
  'OTHER',
] as const;

export const reportUserRequestSchema = z.strictObject({
  ogcId: ogcIdInputSchema,
  category: z.enum(REPORT_CATEGORIES, 'Choose a report category'),
  description: z
    .string()
    .transform((value) => value.normalize('NFKC').trim())
    .pipe(
      z
        .string()
        .max(
          REPORT_DESCRIPTION_MAX_LENGTH,
          `Use at most ${REPORT_DESCRIPTION_MAX_LENGTH} characters`,
        )
        .refine((value) => !CONTROL_EXCEPT_NEWLINE.test(value), {
          message: 'Remove unsupported characters',
        }),
    )
    .optional(),
});

/** Query string of paginated list endpoints. The cursor is opaque to clients. */
export const pageQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/, 'Invalid cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export type UpdateProfileRequest = z.input<typeof updateProfileRequestSchema>;
export type UpdateProfileInput = z.output<typeof updateProfileRequestSchema>;
export type ReportUserRequest = z.input<typeof reportUserRequestSchema>;
export type ReportUserInput = z.output<typeof reportUserRequestSchema>;
export type PageQuery = z.output<typeof pageQuerySchema>;
