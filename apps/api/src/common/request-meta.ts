import { isIP } from 'node:net';
import type { Request } from 'express';

/** Client metadata recorded with security events. Untrusted, informational only. */
export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

const MAX_USER_AGENT = 256;

export function requestMeta(req: Request): RequestMeta {
  const meta: RequestMeta = {};
  // `req.ip` honours TRUST_PROXY_HOPS, so X-Forwarded-For is only used when configured.
  if (req.ip && isIP(req.ip)) meta.ipAddress = req.ip;
  const userAgent = req.get('user-agent');
  if (userAgent) meta.userAgent = userAgent.slice(0, MAX_USER_AGENT);
  return meta;
}
