import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiErrorBody, ApiErrorCode } from '@ogc/types';
import type { Request, Response } from 'express';

const GENERIC_MESSAGE = 'An unexpected error occurred';

function messageFrom(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const { message } = body as { message?: unknown };
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : exception.message;
}

function codeFrom(exception: HttpException): ApiErrorCode | undefined {
  if (exception instanceof ThrottlerException) return 'RATE_LIMITED';
  const body = exception.getResponse();
  if (typeof body !== 'object') return undefined;
  const { code } = body as { code?: unknown };
  return typeof code === 'string' ? (code as ApiErrorCode) : undefined;
}

/**
 * Client errors raised by Express middleware (e.g. body-parser's 400 / 413)
 * follow the `http-errors` convention: a 4xx `status` and `expose: true`
 * marking the message as safe to show.
 */
function exposedClientError(exception: unknown): { status: number; message: string } | undefined {
  if (!(exception instanceof Error)) return undefined;
  const { status, expose } = exception as Error & { status?: unknown; expose?: unknown };
  if (expose === true && typeof status === 'number' && status >= 400 && status < 500) {
    return { status, message: exception.message };
  }
  return undefined;
}

/**
 * Converts every error into a consistent `ApiErrorBody`. Unexpected errors are
 * logged server-side with full detail but reach the client as a generic 500,
 * so stack traces and internal messages are never leaked.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const requestId = typeof request.id === 'string' ? request.id : undefined;

    let statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = GENERIC_MESSAGE;
    let code: ApiErrorCode | undefined;

    const clientError = exposedClientError(exception);
    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      if (statusCode < 500) {
        message = messageFrom(exception);
        code = codeFrom(exception);
      }
    } else if (clientError) {
      statusCode = clientError.status;
      message = clientError.message;
    }

    if (statusCode >= 500) {
      this.logger.error(
        { err: exception, requestId },
        exception instanceof Error ? exception.message : 'Non-error thrown',
      );
    }

    // Reverse enum lookup is typed `string` but is undefined for non-standard codes.
    const statusName: string | undefined = HttpStatus[statusCode];
    const body: ApiErrorBody = {
      statusCode,
      error: statusName ?? 'ERROR',
      message,
      ...(code ? { code } : {}),
      ...(requestId ? { requestId } : {}),
    };
    response.status(statusCode).json(body);
  }
}
