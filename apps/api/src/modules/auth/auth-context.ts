import type { AccountStatus, OgcId } from '@ogc/types';
import type { Request } from 'express';
import type { StaffRole } from '../../generated/prisma/client.js';

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
  /** Platform staff roles, loaded from the database on every request (never from the client). */
  staffRoles: StaffRole[];
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };
