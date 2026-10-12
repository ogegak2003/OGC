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

export const unauthenticated = (): ApiException =>
  new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Authentication required');
