import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiException } from '../errors.js';

/**
 * Validates and normalises a request payload with a Zod schema. Error
 * messages name fields and rules only; submitted values are never echoed.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const message = result.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      )
      .join('; ');
    throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message);
  }
}
