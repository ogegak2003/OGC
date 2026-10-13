import { type MessagingTransport, TransportError } from '@ogc/messaging';
import type {
  AttachmentUploadResult,
  ClaimedKeyPackage,
  CommitAccepted,
  ConversationChanges,
  ConversationView,
  DeviceKeyView,
  DirectoryDevice,
  MessagePage,
  MessageView,
  MlsGroupView,
  Page,
  SyncPage,
  WelcomeView,
} from '@ogc/types';
import { ApiError, type ApiClient } from '../api/client';
import { cacheFile } from './native-store';

const enc = encodeURIComponent;

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError)
      throw new TransportError(error.message, error.status, error.code);
    throw new TransportError(error instanceof Error ? error.message : 'Network error', 0);
  }
}

/**
 * The messaging engine's transport for the native app (bearer tokens). Bodies
 * contain only ciphertext, public MLS data and routing metadata.
 */
export function nativeTransport(client: ApiClient): MessagingTransport {
  const get = <T>(path: string) => call(() => client.request<T>('GET', path));
  const post = <T>(path: string, body?: unknown) =>
    call(() => client.request<T>('POST', path, body));
  return {
    registerDeviceKey: (signaturePublicKey) =>
      call(() =>
        client.request<DeviceKeyView>('PUT', '/v1/e2ee/device-key', { signaturePublicKey }),
      ),
    currentDeviceKey: async () => {
      try {
        return await get<DeviceKeyView>('/v1/e2ee/device-key');
      } catch (error) {
        if (error instanceof TransportError && error.status === 404) return null;
        throw error;
      }
    },
    uploadKeyPackages: (keyPackages) =>
      post<DeviceKeyView>('/v1/e2ee/key-packages', { keyPackages }),
    welcomes: () => get<WelcomeView[]>('/v1/e2ee/welcomes'),
    acknowledgeWelcome: (id) =>
      call(() => client.request<undefined>('DELETE', `/v1/e2ee/welcomes/${enc(id)}`)),
    listConversations: (cursor) =>
      get<Page<ConversationView>>(`/v1/conversations${cursor ? `?cursor=${enc(cursor)}` : ''}`),
    conversationChanges: (since) =>
      get<ConversationChanges>(`/v1/conversations/changes${since ? `?since=${enc(since)}` : ''}`),
    openConversation: (ogcId) => post<ConversationView>('/v1/conversations', { ogcId }),
    conversation: (id) => get<ConversationView>(`/v1/conversations/${enc(id)}`),
    directory: (id) => get<DirectoryDevice[]>(`/v1/conversations/${enc(id)}/devices`),
    mlsGroup: (id) => get<MlsGroupView>(`/v1/conversations/${enc(id)}/mls`),
    claimKeyPackages: (id, deviceKeyIds) =>
      post<ClaimedKeyPackage[]>(`/v1/conversations/${enc(id)}/mls/key-packages`, { deviceKeyIds }),
    submitCommit: (id, commit) =>
      post<CommitAccepted>(`/v1/conversations/${enc(id)}/mls/commits`, commit),
    sendMessage: (id, message) =>
      post<MessageView>(`/v1/conversations/${enc(id)}/messages`, message),
    editMessage: (id, edit) =>
      call(() => client.request<MessageView>('PATCH', `/v1/messages/${enc(id)}`, edit)),
    deleteMessage: (id, scope) =>
      call(() => client.request<undefined>('DELETE', `/v1/messages/${enc(id)}?scope=${scope}`)),
    react: (id, reaction, add) =>
      call(() =>
        client.request<undefined>(
          add ? 'PUT' : 'DELETE',
          `/v1/messages/${enc(id)}/reactions/${enc(reaction)}`,
        ),
      ),
    markRead: (id, seq) => post<undefined>(`/v1/conversations/${enc(id)}/read`, { seq }),
    markDelivered: (id, seq) => post<undefined>(`/v1/conversations/${enc(id)}/delivered`, { seq }),
    sync: (id, after, limit) =>
      get<SyncPage>(
        `/v1/conversations/${enc(id)}/sync?after=${String(after)}${limit ? `&limit=${String(limit)}` : ''}`,
      ),
    history: (id, query) => {
      const params = Object.entries(query)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('&');
      return get<MessagePage>(`/v1/conversations/${enc(id)}/messages?${params}`);
    },
    uploadAttachment: async (conversationId, kind, ciphertext) => {
      // React Native's FormData uploads files by URI: stage the ciphertext (never plaintext) in the cache.
      const staged = cacheFile(ciphertext, 'bin');
      try {
        const form = new FormData();
        form.append('conversationId', conversationId);
        form.append('kind', kind);
        form.append('file', {
          uri: staged.uri,
          name: 'attachment.bin',
          type: 'application/octet-stream',
        } as unknown as Blob);
        return await post<AttachmentUploadResult>('/v1/attachments', form);
      } finally {
        if (staged.exists) staged.delete();
      }
    },
    downloadAttachment: (id) => call(() => client.bytes(`/v1/attachments/${enc(id)}`)),
  };
}
