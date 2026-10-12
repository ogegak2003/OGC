import type { OgcId } from './identity.js';

export type AccountStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export type DevicePlatform = 'WEB' | 'ANDROID' | 'IOS' | 'DESKTOP';

/**
 * The signed-in user's own account, as returned by `GET /api/v1/auth/me`.
 * Deliberately excludes internal identifiers and all security metadata.
 */
export interface AccountView {
  ogcId: OgcId;
  displayName: string;
  email: string;
  emailVerified: boolean;
  accountStatus: AccountStatus;
  createdAt: string;
}

/** Timing information about the current session (never the tokens themselves). */
export interface SessionView {
  accessTokenExpiresAt: string;
  expiresAt: string;
}

/** Bearer tokens, returned only to native clients. Browsers receive HttpOnly cookies instead. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Response of `POST /auth/login` and `POST /auth/refresh`. */
export interface AuthResponse {
  account: AccountView;
  session: SessionView;
  tokens?: AuthTokens;
}

/** Response of `POST /auth/register`. Identical whether or not the email was already in use. */
export interface RegisterResponse {
  verificationRequired: true;
  message: string;
}

/** Response of `POST /auth/verify-email`. */
export interface VerifyEmailResponse {
  verified: true;
}

/** Header a client sends to select browser (cookie) mode; also the CSRF defence for cookies. */
export const CLIENT_HEADER = 'x-ogc-client';
export const WEB_CLIENT = 'web';
