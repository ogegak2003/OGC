import {
  type AccountView,
  type ApiErrorBody,
  type ApiErrorCode,
  type AuthResponse,
  CLIENT_HEADER,
  type HealthResponse,
  type RegisterResponse,
  type VerifyEmailResponse,
  WEB_CLIENT,
} from '@ogc/types';
import type { LoginRequest, RegisterRequest } from '@ogc/validation';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Retry once after refreshing the session when the access cookie has expired. */
  retryOnUnauthorized?: boolean;
}

let refreshInFlight: Promise<boolean> | undefined;

/** Single-flight refresh: concurrent 401s share one refresh, avoiding token-reuse detection. */
function refreshSession(): Promise<boolean> {
  refreshInFlight ??= send<AuthResponse>('/v1/auth/refresh', {
    method: 'POST',
    body: {},
    retryOnUnauthorized: false,
  })
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = undefined;
    });
  return refreshInFlight;
}

/**
 * Calls the OGC API in browser mode: credentials travel only in HttpOnly
 * cookies (never readable here), and the client header doubles as CSRF proof.
 */
async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, retryOnUnauthorized = true } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    [CLIENT_HEADER]: WEB_CLIENT,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 && retryOnUnauthorized && (await refreshSession())) {
    return send<T>(path, { ...options, retryOnUnauthorized: false });
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      error?.message ?? 'Something went wrong. Please try again.',
      error?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: (signal?: AbortSignal) =>
    send<HealthResponse>('/v1/health', { signal, retryOnUnauthorized: false }),
  me: (signal?: AbortSignal) => send<AccountView>('/v1/auth/me', { signal }),
  register: (body: RegisterRequest) =>
    send<RegisterResponse>('/v1/auth/register', {
      method: 'POST',
      body,
      retryOnUnauthorized: false,
    }),
  login: (body: Omit<LoginRequest, 'device'>) =>
    send<AuthResponse>('/v1/auth/login', { method: 'POST', body, retryOnUnauthorized: false }),
  logout: () => send<undefined>('/v1/auth/logout', { method: 'POST' }),
  verifyEmail: (token: string) =>
    send<VerifyEmailResponse>('/v1/auth/verify-email', {
      method: 'POST',
      body: { token },
      retryOnUnauthorized: false,
    }),
  resendVerification: () =>
    send<{ message: string }>('/v1/auth/verify-email/resend', { method: 'POST' }),
};
