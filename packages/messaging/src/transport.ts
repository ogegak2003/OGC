import type {
  ApiErrorCode,
  AttachmentKind,
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
  ReactionType,
  SyncPage,
  WelcomeView,
} from '@ogc/types';

/**
 * The REST calls the messaging engine needs. Web and mobile implement it with
 * their own authenticated API clients (cookies vs bearer tokens); tests
 * implement it against a real API instance. Implementations must throw a
 * `TransportError` for API errors so the engine can react to error codes.
 */
export interface MessagingTransport {
  registerDeviceKey(signaturePublicKey: string): Promise<DeviceKeyView>;
  currentDeviceKey(): Promise<DeviceKeyView | null>;
  uploadKeyPackages(keyPackages: string[]): Promise<DeviceKeyView>;
  welcomes(): Promise<WelcomeView[]>;
  acknowledgeWelcome(id: string): Promise<void>;

  listConversations(cursor?: string): Promise<Page<ConversationView>>;
  conversationChanges(since?: string): Promise<ConversationChanges>;
  openConversation(ogcId: string): Promise<ConversationView>;
  conversation(id: string): Promise<ConversationView>;
  directory(conversationId: string): Promise<DirectoryDevice[]>;

  mlsGroup(conversationId: string): Promise<MlsGroupView>;
  claimKeyPackages(conversationId: string, deviceKeyIds: string[]): Promise<ClaimedKeyPackage[]>;
  submitCommit(
    conversationId: string,
    commit: { epoch: number; commit: string; groupInfo: string; welcome?: string },
  ): Promise<CommitAccepted>;

  sendMessage(
    conversationId: string,
    message: {
      clientMessageId: string;
      epoch: number;
      ciphertext: string;
      replyToId?: string;
      forwardedFromId?: string;
      attachmentIds?: string[];
      mentions?: string[];
    },
  ): Promise<MessageView>;
  editMessage(messageId: string, edit: { epoch: number; ciphertext: string }): Promise<MessageView>;
  deleteMessage(messageId: string, scope: 'everyone' | 'self'): Promise<void>;
  react(messageId: string, reaction: ReactionType, add: boolean): Promise<void>;
  markRead(conversationId: string, seq: number): Promise<void>;
  markDelivered(conversationId: string, seq: number): Promise<void>;
  sync(conversationId: string, after: number, limit?: number): Promise<SyncPage>;
  history(
    conversationId: string,
    query: { before?: number; after?: number; limit?: number },
  ): Promise<MessagePage>;

  uploadAttachment(
    conversationId: string,
    kind: AttachmentKind,
    ciphertext: Uint8Array,
  ): Promise<AttachmentUploadResult>;
  downloadAttachment(attachmentId: string): Promise<Uint8Array>;
}

/** An API error response, or a network failure (`status` 0, no code). */
export class TransportError extends Error {
  override readonly name = 'TransportError';

  constructor(
    message: string,
    readonly status: number,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
  }

  /** True when the request may succeed if retried later (offline, timeouts, server errors). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function errorCode(error: unknown): ApiErrorCode | undefined {
  return error instanceof TransportError ? error.code : undefined;
}

export function isRetryable(error: unknown): boolean {
  return error instanceof TransportError ? error.retryable : false;
}
