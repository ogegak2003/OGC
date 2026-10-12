import { CLIENT_HEADER, WEB_CLIENT } from '@ogc/types';
import type { CookieOptions, Request, Response } from 'express';

/**
 * Browser credentials live in HttpOnly cookies that JavaScript cannot read.
 *
 * - `__Host-` prefix (secure mode): host-only, Path=/, Secure — cannot be set
 *   or overwritten by subdomains or insecure origins.
 * - `__Secure-` refresh cookie is scoped to the auth endpoints only.
 * - SameSite=Strict: never sent on cross-site requests.
 *
 * Without TLS (local development) the prefixes are dropped, as browsers
 * reject prefixed cookies that are not Secure.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieNames {
  access: string;
  refresh: string;
}

export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { access: '__Host-ogc_at', refresh: '__Secure-ogc_rt' }
    : { access: 'ogc_at', refresh: 'ogc_rt' };
}

function baseOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict' };
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  expiresAt: Date;
}

export function setAuthCookies(res: Response, tokens: IssuedTokens, secure: boolean): void {
  const names = cookieNames(secure);
  const now = Date.now();
  res.cookie(names.access, tokens.accessToken, {
    ...baseOptions(secure),
    path: '/',
    maxAge: tokens.accessExpiresAt.getTime() - now,
  });
  res.cookie(names.refresh, tokens.refreshToken, {
    ...baseOptions(secure),
    path: REFRESH_COOKIE_PATH,
    maxAge: tokens.expiresAt.getTime() - now,
  });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  const names = cookieNames(secure);
  res.clearCookie(names.access, { ...baseOptions(secure), path: '/' });
  res.clearCookie(names.refresh, { ...baseOptions(secure), path: REFRESH_COOKIE_PATH });
}

export function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Browser clients identify themselves with `X-OGC-Client: web` and receive cookies. */
export function isWebClient(req: Request): boolean {
  return req.get(CLIENT_HEADER) === WEB_CLIENT;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests. A cross-site page cannot set
 * custom headers without a CORS preflight, which the API's origin allowlist
 * rejects; SameSite=Strict cookies are the first line of defence.
 */
export function passesCsrfCheck(req: Request): boolean {
  return SAFE_METHODS.has(req.method) || isWebClient(req);
}
