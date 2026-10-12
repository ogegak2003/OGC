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

/**
 * Error body returned by the API. Never contains stack traces or internal
 * details; `requestId` correlates with server-side structured logs.
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  requestId?: string;
}
