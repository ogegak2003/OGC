import type { ArgumentsHost } from '@nestjs/common';
import { HttpStatus, InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../errors.js';
import { HttpExceptionFilter } from './http-exception.filter.js';

function run(exception: unknown) {
  const json = vi.fn((_body: Record<string, unknown>) => undefined);
  const status = vi.fn((_code: number) => ({ json }));
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-1' }), getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
}

describe('HttpExceptionFilter', () => {
  it('keeps curated messages and codes for deliberate 5xx ApiExceptions', () => {
    const { status, body } = run(
      new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'MEDIA_UNAVAILABLE',
        'Profile photos are not available right now',
      ),
    );
    expect(status).toBe(503);
    expect(body).toMatchObject({
      code: 'MEDIA_UNAVAILABLE',
      message: 'Profile photos are not available right now',
    });
  });

  it('hides details of unexpected errors and of non-curated 5xx exceptions', () => {
    for (const exception of [
      new Error('db password=secret'),
      new InternalServerErrorException('internal detail'),
    ]) {
      const { status, body } = run(exception);
      expect(status).toBe(500);
      expect(body).toEqual({
        statusCode: 500,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'req-1',
      });
    }
  });

  it('passes 4xx codes through', () => {
    const { status, body } = run(new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found'));
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
