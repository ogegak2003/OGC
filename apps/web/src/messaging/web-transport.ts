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
import { ApiError, send, sendForBytes } from '../lib/api';

const enc = encodeURIComponent;

/** Maps web API errors (and network failures) onto the engine's transport error. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError)
      throw new TransportError(error.message, error.status, error.code, error.retryAfterSeconds);
    throw new TransportError(error instanceof Error ? error.message : 'Network error', 0);
  }
}

/**
 * The messaging engine's transport for browsers: the same cookie session and
 * CSRF header as the rest of the web app. Request bodies contain only
 * ciphertext, public MLS data and routing metadata.
 */
export const webTransport: MessagingTransport = {
  registerDeviceKey: (signaturePublicKey) =>
    call(() =>
      send<DeviceKeyView>('/v1/e2ee/device-key', { method: 'PUT', body: { signaturePublicKey } }),
    ),
  currentDeviceKey: async () => {
    try {
      return await call(() => send<DeviceKeyView>('/v1/e2ee/device-key'));
    } catch (error) {
      if (error instanceof TransportError && error.status === 404) return null;
      throw error;
    }
  },
  uploadKeyPackages: (keyPackages) =>
    call(() =>
      send<DeviceKeyView>('/v1/e2ee/key-packages', { method: 'POST', body: { keyPackages } }),
    ),
  welcomes: () => call(() => send<WelcomeView[]>('/v1/e2ee/welcomes')),
  acknowledgeWelcome: (id) =>
    call(() => send<undefined>(`/v1/e2ee/welcomes/${enc(id)}`, { method: 'DELETE' })),

  listConversations: (cursor) =>
    call(() =>
      send<Page<ConversationView>>(`/v1/conversations${cursor ? `?cursor=${enc(cursor)}` : ''}`),
    ),
  conversationChanges: (since) =>
    call(() =>
      send<ConversationChanges>(`/v1/conversations/changes${since ? `?since=${enc(since)}` : ''}`),
    ),
  openConversation: (ogcId) =>
    call(() => send<ConversationView>('/v1/conversations', { method: 'POST', body: { ogcId } })),
  conversation: (id) => call(() => send<ConversationView>(`/v1/conversations/${enc(id)}`)),
  directory: (id) => call(() => send<DirectoryDevice[]>(`/v1/conversations/${enc(id)}/devices`)),

  mlsGroup: (id) => call(() => send<MlsGroupView>(`/v1/conversations/${enc(id)}/mls`)),
  claimKeyPackages: (id, deviceKeyIds) =>
    call(() =>
      send<ClaimedKeyPackage[]>(`/v1/conversations/${enc(id)}/mls/key-packages`, {
        method: 'POST',
        body: { deviceKeyIds },
      }),
    ),
  submitCommit: (id, commit) =>
    call(() =>
      send<CommitAccepted>(`/v1/conversations/${enc(id)}/mls/commits`, {
        method: 'POST',
        body: commit,
      }),
    ),

  sendMessage: (id, message) =>
    call(() =>
      send<MessageView>(`/v1/conversations/${enc(id)}/messages`, { method: 'POST', body: message }),
    ),
  editMessage: (id, edit) =>
    call(() => send<MessageView>(`/v1/messages/${enc(id)}`, { method: 'PATCH', body: edit })),
  deleteMessage: (id, scope) =>
    call(() => send<undefined>(`/v1/messages/${enc(id)}?scope=${scope}`, { method: 'DELETE' })),
  react: (id, reaction, add) =>
    call(() =>
      send<undefined>(`/v1/messages/${enc(id)}/reactions/${enc(reaction)}`, {
        method: add ? 'PUT' : 'DELETE',
      }),
    ),
  markRead: (id, seq) =>
    call(() =>
      send<undefined>(`/v1/conversations/${enc(id)}/read`, { method: 'POST', body: { seq } }),
    ),
  markDelivered: (id, seq) =>
    call(() =>
      send<undefined>(`/v1/conversations/${enc(id)}/delivered`, { method: 'POST', body: { seq } }),
    ),
  sync: (id, after, limit) =>
    call(() =>
      send<SyncPage>(
        `/v1/conversations/${enc(id)}/sync?after=${String(after)}${limit ? `&limit=${String(limit)}` : ''}`,
      ),
    ),
  history: (id, query) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    return call(() =>
      send<MessagePage>(`/v1/conversations/${enc(id)}/messages?${params.toString()}`),
    );
  },

  uploadAttachment: (conversationId, kind, ciphertext) => {
    const form = new FormData();
    form.append('conversationId', conversationId);
    form.append('kind', kind);
    // The file name is fixed: the real name travels only inside the encrypted message.
    form.append(
      'file',
      new Blob([Uint8Array.from(ciphertext)], { type: 'application/octet-stream' }),
      'attachment.bin',
    );
    return call(() =>
      send<AttachmentUploadResult>('/v1/attachments', { method: 'POST', body: form }),
    );
  },
  downloadAttachment: (id) => call(() => sendForBytes(`/v1/attachments/${enc(id)}`)),
};
