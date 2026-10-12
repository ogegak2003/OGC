import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Env } from '../../config/env.schema.js';

/** Accept caller-supplied request IDs only if they are short and safe to log. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Headers and fields that must never appear in logs. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
];

export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

export function loggerConfig(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: resolveRequestId,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      // Keep request logs small: no bodies, no query strings with potential tokens.
      serializers: {
        req: (req: { id: unknown; method: unknown; url?: unknown }) => ({
          id: req.id,
          method: req.method,
          path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        }),
        res: (res: { statusCode: unknown }) => ({ statusCode: res.statusCode }),
      },
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
    },
  };
}
