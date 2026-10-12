import { pageQuerySchema } from '@ogc/validation';
import { z } from 'zod';

/** Query string of the moderator report queue. */
export const adminReportQuerySchema = z
  .strictObject({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).default('OPEN') })
  .extend(pageQuerySchema.shape);

export type AdminReportQuery = z.output<typeof adminReportQuerySchema>;
