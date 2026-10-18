import {
  type AccountView,
  type ApiErrorBody,
  type ApiErrorCode,
  type AuthResponse,
  CLIENT_HEADER,
  type DeviceSessionView,
  type ForgotPasswordResponse,
  type ResetPasswordResponse,
  type HealthResponse,
  type RegisterResponse,
  type VerifyEmailResponse,
  WEB_CLIENT,
} from '@ogc/types';
import { parseRetryAfter } from '@ogc/messaging';
import type {
  BlockView,
  CallPage,
  ContactRequestResult,
  ContactRequestView,
  ContactView,
  NotificationSettingsView,
  OwnProfile,
  Page,
  PublicProfile,
} from '@ogc/types';
import type {
  ChangePasswordRequest,
  ResetPasswordRequest,
  LoginRequest,
  NotificationSettingsUpdate,
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
    /** Seconds from the response's `Retry-After`, when present. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Retry once after refreshing the session when the access cookie has expired. */
  retryOnUnauthorized?: boolean;
  /** Let the request finish (and its cookies be stored) even if the page unloads. */
  keepalive?: boolean;
}

let refreshInFlight: Promise<boolean> | undefined;

/**
 * Single-flight refresh: concurrent 401s share one refresh, avoiding token-reuse detection.
 * Sent with `keepalive`: the server rotates the refresh token as soon as it answers, so if
 * the page navigated away mid-request and the browser dropped the new cookie, the next page
 * would present the old token, which the server treats as reuse and revokes the session.
 */
function refreshSession(): Promise<boolean> {
  refreshInFlight ??= send<AuthResponse>('/v1/auth/refresh', {
    method: 'POST',
    body: {},
    retryOnUnauthorized: false,
    keepalive: true,
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
export async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, retryOnUnauthorized = true, keepalive } = options;
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
    ...(keepalive ? { keepalive } : {}),
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
      parseRetryAfter(response.headers.get('Retry-After')),
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Downloads binary data (encrypted attachments) with the same session and refresh rules. */
export async function sendForBytes(path: string, retryOnUnauthorized = true): Promise<Uint8Array> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { [CLIENT_HEADER]: WEB_CLIENT },
    credentials: 'same-origin',
  });
  if (response.status === 401 && retryOnUnauthorized && (await refreshSession())) {
    return sendForBytes(path, false);
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiError(response.status, error?.message ?? 'Download failed', error?.code);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Renews the session cookie (used before reconnecting the realtime socket). */
export function renewSession(): Promise<boolean> {
  return refreshSession();
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

  // ---------- Password recovery ----------
  forgotPassword: (email: string) =>
    send<ForgotPasswordResponse>('/v1/auth/password/forgot', {
      method: 'POST',
      body: { email },
      retryOnUnauthorized: false,
    }),
  resetPassword: (body: ResetPasswordRequest) =>
    send<ResetPasswordResponse>('/v1/auth/password/reset', {
      method: 'POST',
      body,
      retryOnUnauthorized: false,
    }),

  // ---------- Devices and password ----------
  sessions: (signal?: AbortSignal) => send<DeviceSessionView[]>('/v1/auth/sessions', { signal }),
  revokeSession: (id: string) =>
    send<undefined>(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeOtherSessions: () =>
    send<{ ended: number }>('/v1/auth/sessions/revoke-others', { method: 'POST' }),
  changePassword: (body: ChangePasswordRequest) =>
    send<{ otherSessionsEnded: number }>('/v1/auth/password', {
      method: 'POST',
      body,
      // A wrong current password is a 400, but never retry a password submission.
      retryOnUnauthorized: false,
    }),

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

  // ---------- Notification settings ----------
  notificationSettings: (signal?: AbortSignal) =>
    send<NotificationSettingsView>('/v1/notifications/settings', { signal }),
  updateNotificationSettings: (body: NotificationSettingsUpdate) =>
    send<NotificationSettingsView>('/v1/notifications/settings', { method: 'PUT', body }),

  // ---------- Calls ----------
  /** Call history (metadata only), newest first; optionally one conversation's calls. */
  calls: (conversationId?: string, signal?: AbortSignal) =>
    send<CallPage>(
      `/v1/calls?limit=50${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}`,
      { signal },
    ),
};

function pageQuery(cursor: string | undefined): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
}
