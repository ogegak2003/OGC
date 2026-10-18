import type {
  AccountView,
  ApiErrorBody,
  ApiErrorCode,
  AuthResponse,
  BlockView,
  CallPage,
  NotificationSettingsView,
  ContactRequestResult,
  ContactRequestView,
  ContactView,
  DevicePlatform,
  DeviceSessionView,
  ForgotPasswordResponse,
  OwnProfile,
  Page,
  PublicProfile,
  RegisterResponse,
  ResetPasswordResponse,
} from '@ogc/types';
import type {
  ChangePasswordRequest,
  ResetPasswordRequest,
  NotificationSettingsUpdate,
  RegisterRequest,
  ReportUserRequest,
  UpdateProfileRequest,
} from '@ogc/validation';
import { parseRetryAfter } from '@ogc/messaging';
import type { TokenStore } from '../auth/token-store';

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

export interface ApiClientOptions {
  baseUrl: string;
  platform: DevicePlatform;
  store: TokenStore;
  fetchImpl?: typeof fetch;
}

/**
 * OGC API client for native apps. Uses bearer tokens (never the browser
 * cookie mode): the access token lives in memory, the refresh token in
 * secure storage, and refresh tokens are rotated on every use.
 */
export class ApiClient {
  private accessToken: string | undefined;
  private refreshInFlight: Promise<boolean> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async send<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      auth?: boolean;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    const { method = 'GET', body, auth = false, retry = true } = init;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && auth && retry && (await this.refresh())) {
      return this.send<T>(path, { ...init, retry: false });
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
      throw new ApiError(
        response.status,
        error?.message ?? 'Request failed',
        error?.code,
        parseRetryAfter(response.headers.get('Retry-After')),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Authenticated request for feature clients (e.g. the messaging transport). */
  request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.send<T>(path, { method, auth: true, ...(body !== undefined ? { body } : {}) });
  }

  /** Authenticated binary download (encrypted attachments), with the same refresh rule. */
  async bytes(path: string, retry = true): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
    });
    if (response.status === 401 && retry && (await this.refresh())) return this.bytes(path, false);
    if (!response.ok) {
      const error = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
      throw new ApiError(response.status, error?.message ?? 'Download failed', error?.code);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** The current access token, for authenticating the realtime connection. */
  async currentAccessToken(): Promise<string | undefined> {
    if (!this.accessToken) await this.refresh();
    return this.accessToken;
  }

  /** API origin (scheme + host), e.g. for the realtime connection. */
  get origin(): string {
    return this.options.baseUrl.replace(/\/api\/?$/, '');
  }

  private async adopt(response: AuthResponse): Promise<AccountView> {
    if (!response.tokens) throw new ApiError(500, 'Missing tokens in response');
    this.accessToken = response.tokens.accessToken;
    await this.options.store.setRefreshToken(response.tokens.refreshToken);
    return response.account;
  }

  /** Rotates the refresh token. Concurrent callers share a single request. */
  refresh(): Promise<boolean> {
    this.refreshInFlight ??= (async () => {
      const refreshToken = await this.options.store.getRefreshToken();
      if (!refreshToken) return false;
      try {
        const response = await this.send<AuthResponse>('/v1/auth/refresh', {
          method: 'POST',
          body: { refreshToken },
        });
        await this.adopt(response);
        return true;
      } catch (error) {
        // Only an explicit rejection ends the session; network errors keep it for a retry.
        if (error instanceof ApiError && error.status === 401) await this.forget();
        return false;
      }
    })().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  /** Restores a session from secure storage after an app restart. */
  async restore(): Promise<AccountView | undefined> {
    if (!(await this.refresh())) return undefined;
    return this.me();
  }

  register(body: RegisterRequest): Promise<RegisterResponse> {
    return this.send('/v1/auth/register', { method: 'POST', body });
  }

  async login(email: string, password: string): Promise<AccountView> {
    const response = await this.send<AuthResponse>('/v1/auth/login', {
      method: 'POST',
      body: { email, password, device: { platform: this.options.platform } },
    });
    return this.adopt(response);
  }

  me(): Promise<AccountView> {
    return this.send('/v1/auth/me', { auth: true });
  }

  resendVerification(): Promise<{ message: string }> {
    return this.send('/v1/auth/verify-email/resend', { method: 'POST', auth: true });
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken)
        await this.send('/v1/auth/logout', { method: 'POST', auth: true, retry: false });
    } finally {
      await this.forget();
    }
  }

  // ---------- Password recovery (signed out) ----------
  /** Asks for a reset link; the answer is the same whether or not the address has an account. */
  forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    return this.send('/v1/auth/password/forgot', { method: 'POST', body: { email } });
  }

  /** Sets a new password with the emailed token; every session of the account ends. */
  resetPassword(body: ResetPasswordRequest): Promise<ResetPasswordResponse> {
    return this.send('/v1/auth/password/reset', { method: 'POST', body, retry: false });
  }

  // ---------- Devices and password ----------
  /** The account's signed-in devices; `current` marks this one. */
  sessions(): Promise<DeviceSessionView[]> {
    return this.send('/v1/auth/sessions', { auth: true });
  }

  /** Signs out another device (e.g. a lost phone): its keys and push token are removed. */
  revokeSession(id: string): Promise<void> {
    return this.send(`/v1/auth/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      auth: true,
    });
  }

  revokeOtherSessions(): Promise<{ ended: number }> {
    return this.send('/v1/auth/sessions/revoke-others', { method: 'POST', auth: true });
  }

  /** Changes the password; every other device is signed out. */
  changePassword(body: ChangePasswordRequest): Promise<{ otherSessionsEnded: number }> {
    return this.send('/v1/auth/password', { method: 'POST', body, auth: true, retry: false });
  }

  // ---------- Profile ----------
  profile(): Promise<OwnProfile> {
    return this.send('/v1/profile', { auth: true });
  }

  updateProfile(body: UpdateProfileRequest): Promise<OwnProfile> {
    return this.send('/v1/profile', { method: 'PATCH', body, auth: true });
  }

  /** Uploads a local image file (from the image picker). The server re-validates and re-encodes it. */
  uploadAvatar(file: { uri: string; mimeType: string }): Promise<OwnProfile> {
    const form = new FormData();
    // React Native's FormData accepts a { uri, name, type } file descriptor.
    form.append('avatar', {
      uri: file.uri,
      name: 'avatar',
      type: file.mimeType,
    } as unknown as Blob);
    return this.send('/v1/profile/avatar', { method: 'POST', body: form, auth: true });
  }

  removeAvatar(): Promise<OwnProfile> {
    return this.send('/v1/profile/avatar', { method: 'DELETE', auth: true });
  }

  /** Image source for a profile photo: fetched with the bearer token so privacy rules apply. */
  avatarSource(avatarUrl: string | null): { uri: string; headers: Record<string, string> } | null {
    if (!avatarUrl || !this.accessToken) return null;
    const origin = this.options.baseUrl.replace(/\/api\/?$/, '');
    return {
      uri: `${origin}${avatarUrl}`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
    };
  }

  // ---------- Discovery and profiles ----------
  discover(input: string): Promise<PublicProfile> {
    return this.send(`/v1/discovery/ogc/${encodeURIComponent(input)}`, { auth: true });
  }

  publicProfile(ogcId: string): Promise<PublicProfile> {
    return this.send(`/v1/profiles/${encodeURIComponent(ogcId)}`, { auth: true });
  }

  // ---------- Contacts ----------
  contacts(cursor?: string): Promise<Page<ContactView>> {
    return this.send(`/v1/contacts${page(cursor)}`, { auth: true });
  }

  incomingRequests(cursor?: string): Promise<Page<ContactRequestView>> {
    return this.send(`/v1/contacts/requests/incoming${page(cursor)}`, { auth: true });
  }

  outgoingRequests(cursor?: string): Promise<Page<ContactRequestView>> {
    return this.send(`/v1/contacts/requests/outgoing${page(cursor)}`, { auth: true });
  }

  sendContactRequest(ogcId: string): Promise<ContactRequestResult> {
    return this.send('/v1/contacts/requests', { method: 'POST', body: { ogcId }, auth: true });
  }

  acceptRequest(id: string): Promise<void> {
    return this.send(`/v1/contacts/requests/${encodeURIComponent(id)}/accept`, {
      method: 'POST',
      auth: true,
    });
  }

  declineRequest(id: string): Promise<void> {
    return this.send(`/v1/contacts/requests/${encodeURIComponent(id)}/decline`, {
      method: 'POST',
      auth: true,
    });
  }

  cancelRequest(id: string): Promise<void> {
    return this.send(`/v1/contacts/requests/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      auth: true,
    });
  }

  removeContact(ogcId: string): Promise<void> {
    return this.send(`/v1/contacts/${encodeURIComponent(ogcId)}`, { method: 'DELETE', auth: true });
  }

  // ---------- Blocks and reports ----------
  blocks(cursor?: string): Promise<Page<BlockView>> {
    return this.send(`/v1/blocks${page(cursor)}`, { auth: true });
  }

  block(ogcId: string): Promise<void> {
    return this.send(`/v1/blocks/${encodeURIComponent(ogcId)}`, { method: 'POST', auth: true });
  }

  unblock(ogcId: string): Promise<void> {
    return this.send(`/v1/blocks/${encodeURIComponent(ogcId)}`, { method: 'DELETE', auth: true });
  }

  reportUser(body: ReportUserRequest): Promise<{ received: true }> {
    return this.send('/v1/reports/users', { method: 'POST', body, auth: true });
  }

  // ---------- Push notifications ----------
  /** Registers this device's push token (the server binds it to this session's device). */
  registerPushToken(token: string): Promise<void> {
    return this.send('/v1/notifications/push-token', {
      method: 'PUT',
      body: { provider: 'EXPO', token },
      auth: true,
    });
  }

  unregisterPushToken(): Promise<void> {
    return this.send('/v1/notifications/push-token', { method: 'DELETE', auth: true });
  }

  notificationSettings(): Promise<NotificationSettingsView> {
    return this.send('/v1/notifications/settings', { auth: true });
  }

  updateNotificationSettings(body: NotificationSettingsUpdate): Promise<NotificationSettingsView> {
    return this.send('/v1/notifications/settings', { method: 'PUT', body, auth: true });
  }

  // ---------- Calls ----------
  /** Call history (metadata only), newest first; optionally one conversation's calls. */
  calls(conversationId?: string): Promise<CallPage> {
    const filter = conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : '';
    return this.send(`/v1/calls?limit=50${filter}`, { auth: true });
  }

  private async forget(): Promise<void> {
    this.accessToken = undefined;
    await this.options.store.clear();
  }
}

function page(cursor: string | undefined): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
}
