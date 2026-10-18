import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@ogc/types';

/**
 * An HTTP error with a stable machine-readable `code`. The message is shown
 * to clients, so it must be generic and never include secrets or internals.
 */
export class ApiException extends HttpException {
  constructor(status: HttpStatus, code: ApiErrorCode, message: string) {
    super({ message, code }, status);
  }
}

/** A 429 that tells the client when to retry (sent as `Retry-After`, in whole seconds). */
export class RetryLaterException extends ApiException {
  constructor(
    code: ApiErrorCode,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(HttpStatus.TOO_MANY_REQUESTS, code, message);
  }
}

export const unauthenticated = (): ApiException =>
  new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Authentication required');
