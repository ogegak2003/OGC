import type { AccountStatus, OgcId } from '@ogc/types';
import type { Request } from 'express';

/**
 * The verified identity behind a request, established by `AuthGuard` from a
 * session token. Endpoints must take user identity from here — never from
 * client-supplied IDs. Future authorization (roles, permissions) extends this.
 */
export interface AuthContext {
  userId: string;
  ogcId: OgcId;
  accountStatus: AccountStatus;
  sessionId: string;
  deviceId: string;
  /** How the token was presented; cookie-authenticated requests are CSRF-checked. */
  via: 'cookie' | 'bearer';
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };
