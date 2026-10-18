import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rawKeySealer } from '@ogc/e2ee';
import {
  MemoryKeyValueStore,
  MessagingClient,
  type MessagingTransport,
  SealedStore,
  TransportError,
  parseRetryAfter,
} from '@ogc/messaging';
import {
  type ApiErrorBody,
  type ClientToServerEvents,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  type ServerToClientEvents,
} from '@ogc/types';
import { type Socket, io } from 'socket.io-client';
import { type TestApp, type TestUser, clientIp, nativeTokens } from './test-app.js';

/** Starts the HTTP server on an ephemeral port (needed for fetch and WebSockets). */
export async function listen(t: TestApp): Promise<string> {
  await t.app.listen(0, '127.0.0.1');
  const server = t.app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A real HTTP implementation of the engine's transport, authenticated with a bearer token. */
export class HttpTransport implements MessagingTransport {
  /** Every request body sent, for asserting what the server could observe. */
  readonly sentBodies: string[] = [];
  private readonly ip = clientIp();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const json = body === undefined ? undefined : JSON.stringify(body);
    if (json) this.sentBodies.push(json);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Forwarded-For': this.ip,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(json ? { body: json } : {}),
      });
    } catch (error) {
      throw new TransportError(error instanceof Error ? error.message : 'Network error', 0);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const error = parsed as Partial<ApiErrorBody> | undefined;
      throw new TransportError(
        error?.message ?? response.statusText,
        response.status,
        error?.code,
        parseRetryAfter(response.headers.get('Retry-After')),
      );
    }
    return parsed as T;
  }

  registerDeviceKey: MessagingTransport['registerDeviceKey'] = (signaturePublicKey) =>
    this.call('PUT', '/e2ee/device-key', { signaturePublicKey });
  currentDeviceKey: MessagingTransport['currentDeviceKey'] = async () => {
    try {
      return await this.call('GET', '/e2ee/device-key');
    } catch (error) {
      if (error instanceof TransportError && error.status === 404) return null;
      throw error;
    }
  };
  uploadKeyPackages: MessagingTransport['uploadKeyPackages'] = (keyPackages) =>
    this.call('POST', '/e2ee/key-packages', { keyPackages });
  welcomes: MessagingTransport['welcomes'] = () => this.call('GET', '/e2ee/welcomes');
  acknowledgeWelcome: MessagingTransport['acknowledgeWelcome'] = (id) =>
    this.call('DELETE', `/e2ee/welcomes/${id}`);
  listConversations: MessagingTransport['listConversations'] = (cursor) =>
    this.call('GET', `/conversations${cursor ? `?cursor=${cursor}` : ''}`);
  conversationChanges: MessagingTransport['conversationChanges'] = (since) =>
    this.call('GET', `/conversations/changes${since ? `?since=${since}` : ''}`);
  openConversation: MessagingTransport['openConversation'] = (ogcId) =>
    this.call('POST', '/conversations', { ogcId });
  conversation: MessagingTransport['conversation'] = (id) =>
    this.call('GET', `/conversations/${id}`);
  directory: MessagingTransport['directory'] = (id) =>
    this.call('GET', `/conversations/${id}/devices`);
  mlsGroup: MessagingTransport['mlsGroup'] = (id) => this.call('GET', `/conversations/${id}/mls`);
  claimKeyPackages: MessagingTransport['claimKeyPackages'] = (id, deviceKeyIds) =>
    this.call('POST', `/conversations/${id}/mls/key-packages`, { deviceKeyIds });
  submitCommit: MessagingTransport['submitCommit'] = (id, commit) =>
    this.call('POST', `/conversations/${id}/mls/commits`, commit);
  sendMessage: MessagingTransport['sendMessage'] = (id, message) =>
    this.call('POST', `/conversations/${id}/messages`, message);
  editMessage: MessagingTransport['editMessage'] = (id, edit) =>
    this.call('PATCH', `/messages/${id}`, edit);
  deleteMessage: MessagingTransport['deleteMessage'] = (id, scope) =>
    this.call('DELETE', `/messages/${id}?scope=${scope}`);
  react: MessagingTransport['react'] = (id, reaction, add) =>
    this.call(add ? 'PUT' : 'DELETE', `/messages/${id}/reactions/${reaction}`);
  markRead: MessagingTransport['markRead'] = (id, seq) =>
    this.call('POST', `/conversations/${id}/read`, { seq });
  markDelivered: MessagingTransport['markDelivered'] = (id, seq) =>
    this.call('POST', `/conversations/${id}/delivered`, { seq });
  sync: MessagingTransport['sync'] = (id, after, limit) =>
    this.call('GET', `/conversations/${id}/sync?after=${after}${limit ? `&limit=${limit}` : ''}`);
  history: MessagingTransport['history'] = (id, query) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    return this.call('GET', `/conversations/${id}/messages?${params.toString()}`);
  };
  uploadAttachment: MessagingTransport['uploadAttachment'] = async (
    conversationId,
    kind,
    ciphertext,
  ) => {
    const form = new FormData();
    form.set('conversationId', conversationId);
    form.set('kind', kind);
    form.set('file', new Blob([Uint8Array.from(ciphertext)]), 'ignored-name.bin');
    const response = await fetch(`${this.baseUrl}/api/v1/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'X-Forwarded-For': this.ip },
      body: form,
    });
    const body = (await response.json()) as ApiErrorBody & { id: string; size: number };
    if (!response.ok) throw new TransportError(body.message, response.status, body.code);
    return body;
  };
  downloadAttachment: MessagingTransport['downloadAttachment'] = async (id) => {
    const response = await fetch(`${this.baseUrl}/api/v1/attachments/${id}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'X-Forwarded-For': this.ip },
    });
    if (!response.ok) throw new TransportError('Download failed', response.status);
    return new Uint8Array(await response.arrayBuffer());
  };
}

export interface TestDevice {
  token: string;
  transport: HttpTransport;
  storage: MemoryKeyValueStore;
  /** The device's sealed store (lets tests copy local state, e.g. a stolen device). */
  store: SealedStore;
  client: MessagingClient;
}

/** Signs `user` in on a new device (a fresh session and device record) and starts its engine. */
export async function newDevice(
  t: TestApp,
  baseUrl: string,
  user: TestUser,
  start = true,
): Promise<TestDevice> {
  const { accessToken } = await nativeTokens(t, user.email);
  const transport = new HttpTransport(baseUrl, accessToken);
  const storage = new MemoryKeyValueStore();
  const sealer = rawKeySealer(crypto.getRandomValues(new Uint8Array(32)));
  const store = new SealedStore(storage, sealer);
  const client = new MessagingClient(transport, store, user.ogcId);
  if (start) await client.start();
  return { token: accessToken, transport, storage, store, client };
}

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Opens a realtime connection and records every server event it receives. */
export function connectSocket(
  baseUrl: string,
  auth: { token?: string; cookie?: string; origin?: string },
): { socket: TestSocket; events: { event: string; payload: unknown }[]; connected: Promise<void> } {
  const events: { event: string; payload: unknown }[] = [];
  const socket: TestSocket = io(`${baseUrl}${REALTIME_NAMESPACE}`, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...(auth.token ? { auth: { token: auth.token } } : {}),
    extraHeaders: {
      'X-Forwarded-For': clientIp(),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      ...(auth.origin ? { Origin: auth.origin } : {}),
    },
  });
  socket.onAny((event: string, payload: unknown) => {
    events.push({ event, payload });
  });
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('connect_error', (error) => {
      reject(error);
    });
  });
  return { socket, events, connected };
}

/** Polls until `predicate` holds (realtime and async engine work). */
export async function eventually<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
