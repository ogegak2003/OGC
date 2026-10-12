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
import type {
  BlockView,
  ContactRequestResult,
  ContactRequestView,
  ContactView,
  OwnProfile,
  Page,
  PublicProfile,
} from '@ogc/types';
import type {
  LoginRequest,
  RegisterRequest,
  ReportUserRequest,
  UpdateProfileRequest,
} from '@ogc/validation';

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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
  const isForm = body instanceof FormData;
  // FormData sets its own multipart boundary header.
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
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

  // ---------- Profile ----------
  profile: (signal?: AbortSignal) => send<OwnProfile>('/v1/profile', { signal }),
  updateProfile: (body: UpdateProfileRequest) =>
    send<OwnProfile>('/v1/profile', { method: 'PATCH', body }),
  uploadAvatar: (file: Blob) => {
    const form = new FormData();
    form.append('avatar', file);
    return send<OwnProfile>('/v1/profile/avatar', { method: 'POST', body: form });
  },
  removeAvatar: () => send<OwnProfile>('/v1/profile/avatar', { method: 'DELETE' }),

  // ---------- Discovery and public profiles ----------
  discover: (input: string, signal?: AbortSignal) =>
    send<PublicProfile>(`/v1/discovery/ogc/${encodeURIComponent(input)}`, { signal }),
  publicProfile: (ogcId: string, signal?: AbortSignal) =>
    send<PublicProfile>(`/v1/profiles/${encodeURIComponent(ogcId)}`, { signal }),

  // ---------- Contacts ----------
  contacts: (cursor?: string, signal?: AbortSignal) =>
    send<Page<ContactView>>(`/v1/contacts${pageQuery(cursor)}`, { signal }),
  incomingRequests: (cursor?: string, signal?: AbortSignal) =>
    send<Page<ContactRequestView>>(`/v1/contacts/requests/incoming${pageQuery(cursor)}`, {
      signal,
    }),
  outgoingRequests: (cursor?: string, signal?: AbortSignal) =>
    send<Page<ContactRequestView>>(`/v1/contacts/requests/outgoing${pageQuery(cursor)}`, {
      signal,
    }),
  sendContactRequest: (ogcId: string) =>
    send<ContactRequestResult>('/v1/contacts/requests', { method: 'POST', body: { ogcId } }),
  acceptRequest: (id: string) =>
    send<undefined>(`/v1/contacts/requests/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  declineRequest: (id: string) =>
    send<undefined>(`/v1/contacts/requests/${encodeURIComponent(id)}/decline`, { method: 'POST' }),
  cancelRequest: (id: string) =>
    send<undefined>(`/v1/contacts/requests/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  removeContact: (ogcId: string) =>
    send<undefined>(`/v1/contacts/${encodeURIComponent(ogcId)}`, { method: 'DELETE' }),

  // ---------- Blocks and reports ----------
  blocks: (cursor?: string, signal?: AbortSignal) =>
    send<Page<BlockView>>(`/v1/blocks${pageQuery(cursor)}`, { signal }),
  block: (ogcId: string) =>
    send<undefined>(`/v1/blocks/${encodeURIComponent(ogcId)}`, { method: 'POST' }),
  unblock: (ogcId: string) =>
    send<undefined>(`/v1/blocks/${encodeURIComponent(ogcId)}`, { method: 'DELETE' }),
  reportUser: (body: ReportUserRequest) =>
    send<{ received: true }>('/v1/reports/users', { method: 'POST', body }),
};

function pageQuery(cursor: string | undefined): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
}
