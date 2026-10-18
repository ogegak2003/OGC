export type HealthStatus = 'ok' | 'degraded' | 'down';

/** Liveness: the process is up and able to serve requests. */
export interface HealthResponse {
  status: HealthStatus;
  service: string;
  version: string;
  timestamp: string;
}

/** Readiness: dependencies (database, etc.) are reachable. */
export interface ReadinessResponse extends HealthResponse {
  checks: Record<string, HealthStatus>;
}

/** Stable, machine-readable error codes clients may branch on. */
export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  /** Password change: the current password is wrong. */
  | 'INVALID_PASSWORD'
  | 'ACCOUNT_UNAVAILABLE'
  | 'EMAIL_NOT_VERIFIED'
  | 'INVALID_VERIFICATION_TOKEN'
  /** Password reset: the link is unknown, used, expired or superseded (one answer for all). */
  | 'INVALID_RESET_TOKEN'
  /** No email provider is configured, so recovery emails cannot be sent. */
  | 'EMAIL_UNAVAILABLE'
  | 'CSRF_REJECTED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'CONTACT_REQUESTS_DISABLED'
  | 'INVALID_MEDIA'
  | 'MEDIA_UNAVAILABLE'
  | 'NOT_A_CONTACT'
  | 'BLOCKED'
  | 'STALE_EPOCH'
  | 'E2EE_DEVICE_REQUIRED'
  | 'INVALID_MLS_MESSAGE'
  | 'PAYLOAD_TOO_LARGE'
  | 'MLS_MEMBERSHIP_STALE'
  /** This device rejoined (MLS resync) too often; retry after `Retry-After` seconds. */
  | 'MLS_RESYNC_RATE_LIMITED'
  | 'ARCHIVED'
  | 'MEMBER_LIMIT_REACHED'
  | 'HANDLE_TAKEN'
  | 'INVITATION_INVALID'
  | 'SUSPENDED'
  | 'CONFIRMATION_REQUIRED'
  // OGC Bridge (calls to telephone networks)
  | 'BRIDGE_DISABLED'
  | 'BRIDGE_NOT_CONFIGURED'
  | 'PHONE_NUMBER_INVALID'
  | 'PHONE_NUMBER_UNAVAILABLE'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'RESEND_TOO_SOON'
  | 'BRIDGE_NOT_ELIGIBLE'
  | 'BRIDGE_LIMIT_REACHED'
  | 'WEBHOOK_REJECTED';

/**
 * Error body returned by the API. Never contains stack traces or internal
 * details; `requestId` correlates with server-side structured logs.
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code?: ApiErrorCode;
  requestId?: string;
}
