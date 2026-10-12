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
  | 'ACCOUNT_UNAVAILABLE'
  | 'EMAIL_NOT_VERIFIED'
  | 'INVALID_VERIFICATION_TOKEN'
  | 'CSRF_REJECTED'
  | 'RATE_LIMITED';

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
