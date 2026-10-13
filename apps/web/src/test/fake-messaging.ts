import type { Draft, LocalMessage, MessagingEvent, OutgoingAttachment } from '@ogc/messaging';
import type { ConversationView, OgcId, ReactionType, ServerToClientEvents } from '@ogc/types';
import type { AttachmentDescriptor } from '@ogc/validation';
import { vi } from 'vitest';
import type {
  MessagingDependencies,
  MessagingEngine,
  RealtimeLink,
} from '../messaging/messaging-context';

export const ME = 'OGC306841127';
export const PEER = 'OGC482731905' as OgcId;

export function conversationView(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    type: 'DIRECT',
    peer: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
    version: 3,
    lastActivityAt: new Date().toISOString(),
    lastMessage: null,
    unreadCount: 0,
    myLastReadSeq: 0,
    peerLastReadSeq: 0,
    peerLastDeliveredSeq: 0,
    blockedByMe: false,
    mls: { epoch: 1, ready: true },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function localMessage(overrides: Partial<LocalMessage> = {}): LocalMessage {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    clientMessageId: overrides.clientMessageId ?? crypto.randomUUID(),
    conversationId: conversationView().id,
    seq: 1,
    version: 1,
    senderOgcId: PEER,
    senderDeviceKeyId: null,
    mine: false,
    state: 'ok',
    payload: { v: 1, text: 'Hello' },
    replyToId: null,
    forwarded: false,
    revision: 0,
    editedAt: null,
    createdAt: new Date().toISOString(),
    reactions: [],
    attachmentIds: [],
    ...overrides,
  };
}

type Listener = (event: MessagingEvent) => void;

/**
 * An in-memory stand-in for the encrypted messaging engine, for UI tests.
 * (The real engine and its cryptography are tested end to end in apps/api.)
 */
export class FakeEngine implements MessagingEngine {
  readonly ogcId = ME;
  readonly deviceKeyId = 'device-key';
  readonly listeners = new Set<Listener>();
  data = new Map<string, LocalMessage[]>();
  list: ConversationView[];
  attachments = new Map<string, Uint8Array>();

  constructor(conversations: ConversationView[] = [conversationView()]) {
    this.list = conversations;
  }

  emit(event: MessagingEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  start = vi.fn(() => Promise.resolve());
  conversations = () => this.list;
  conversation = (id: string) => this.list.find((c) => c.id === id);
  refreshConversations = vi.fn(() => {
    this.emit({ type: 'conversations' });
    return Promise.resolve(this.list);
  });
  openDirect = vi.fn((ogcId: string) => {
    const existing =
      this.list.find((c) => c.peer.ogcId === ogcId) ??
      conversationView({
        id: crypto.randomUUID(),
        peer: { ogcId: ogcId as OgcId, displayName: 'New Friend', avatarUrl: null },
      });
    if (!this.list.includes(existing)) this.list = [existing, ...this.list];
    this.emit({ type: 'conversations' });
    return Promise.resolve(existing);
  });
  messages = (conversationId: string) =>
    Promise.resolve([...(this.data.get(conversationId) ?? [])]);
  syncConversation = vi.fn(() => Promise.resolve());
  syncAll = vi.fn(() => Promise.resolve(0));
  send = vi.fn((conversationId: string, draft: Draft & { forwardedFromId?: string }) => {
    const message = localMessage({
      conversationId,
      mine: true,
      senderOgcId: ME,
      seq: (this.data.get(conversationId)?.length ?? 0) + 1,
      payload: {
        v: 1,
        ...(draft.text ? { text: draft.text } : {}),
        ...(draft.attachments ? { attachments: draft.attachments } : {}),
      },
      replyToId: draft.replyToId ?? null,
      forwarded: draft.forwardedFromId !== undefined,
    });
    this.data.set(conversationId, [...(this.data.get(conversationId) ?? []), message]);
    this.emit({ type: 'messages', conversationId });
    return Promise.resolve(message);
  });
  edit = vi.fn((conversationId: string, messageId: string, text: string) => {
    this.data.set(
      conversationId,
      (this.data.get(conversationId) ?? []).map((m) =>
        m.id === messageId
          ? {
              ...m,
              payload: { v: 1, text },
              revision: m.revision + 1,
              editedAt: new Date().toISOString(),
            }
          : m,
      ),
    );
    this.emit({ type: 'messages', conversationId });
    return Promise.resolve();
  });
  deleteForEveryone = vi.fn((conversationId: string, messageId: string) => {
    this.data.set(
      conversationId,
      (this.data.get(conversationId) ?? []).map((m) =>
        m.id === messageId ? { ...m, state: 'deleted' as const, payload: null } : m,
      ),
    );
    this.emit({ type: 'messages', conversationId });
    return Promise.resolve();
  });
  deleteForMe = vi.fn((conversationId: string, messageId: string) => {
    this.data.set(
      conversationId,
      (this.data.get(conversationId) ?? []).filter((m) => m.id !== messageId),
    );
    this.emit({ type: 'messages', conversationId });
    return Promise.resolve();
  });
  react = vi.fn(
    (_conversationId: string, _messageId: string, _reaction: ReactionType, _add: boolean) =>
      Promise.resolve(),
  );
  markRead = vi.fn(() => Promise.resolve());
  forward = vi.fn((_from: string, _messageId: string, target: string) =>
    this.send(target, { text: 'forwarded' }),
  );
  uploadAttachment = vi.fn(
    (_conversationId: string, file: OutgoingAttachment): Promise<AttachmentDescriptor> => {
      const id = crypto.randomUUID();
      this.attachments.set(id, file.bytes);
      return Promise.resolve({
        id,
        kind: file.kind,
        name: file.name,
        mime: file.mime,
        size: file.bytes.length,
        key: 'A'.repeat(43) + '=',
        nonce: 'A'.repeat(32),
        digest: 'A'.repeat(43) + '=',
        ...(file.durationMs ? { durationMs: file.durationMs } : {}),
      });
    },
  );
  openAttachment = vi.fn((descriptor: AttachmentDescriptor) => {
    const bytes = this.attachments.get(descriptor.id);
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('missing'));
  });
  search = vi.fn((query: string) =>
    Promise.resolve(
      [...this.data.values()]
        .flat()
        .filter((m) => m.payload?.text?.toLowerCase().includes(query.toLowerCase())),
    ),
  );
  safetyNumber = vi.fn(() =>
    Promise.resolve([
      '12345',
      '67890',
      '11111',
      '22222',
      '33333',
      '44444',
      '55555',
      '66666',
      '77777',
      '88888',
      '99999',
      '00000',
    ]),
  );
  flushOutbox = vi.fn(() => Promise.resolve(0));
  discardFailed = vi.fn(() => Promise.resolve());
  handleRealtime = vi.fn();
  wipe = vi.fn(() => Promise.resolve());
}

export class FakeRealtime implements RealtimeLink {
  typingCalls: [string, boolean][] = [];
  connect = vi.fn();
  disconnect = vi.fn();
  typing = (conversationId: string, typing: boolean) => {
    this.typingCalls.push([conversationId, typing]);
  };
  subscribePresence = vi.fn((ogcIds: OgcId[]) =>
    Promise.resolve(ogcIds.map((ogcId) => ({ ogcId, state: 'ONLINE' as const }))),
  );
  unsubscribePresence = vi.fn();
}

export interface FakeMessaging {
  engine: FakeEngine;
  realtime: FakeRealtime;
  dependencies: MessagingDependencies;
  destroyed: string[];
  /** Delivers a server event as the realtime connection would. */
  push: <E extends keyof ServerToClientEvents>(
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ) => void;
  setConnection: (state: 'online' | 'offline') => void;
}

export function fakeMessaging(engine = new FakeEngine()): FakeMessaging {
  const realtime = new FakeRealtime();
  const destroyed: string[] = [];
  let deliver: FakeMessaging['push'] = () => undefined;
  let state: (value: 'online' | 'offline' | 'connecting') => void = () => undefined;
  const dependencies: MessagingDependencies = {
    createEngine: () => Promise.resolve(engine),
    createRealtime: (options, onEvent) => {
      deliver = onEvent;
      state = options.onState ?? (() => undefined);
      return realtime;
    },
    destroyLocalData: (ogcId) => {
      destroyed.push(ogcId);
      return Promise.resolve();
    },
  };
  return {
    engine,
    realtime,
    dependencies,
    destroyed,
    push: (event, payload) => {
      deliver(event, payload);
    },
    setConnection: (value) => {
      state(value);
    },
  };
}

/** Dependencies that never start an engine (for screens unrelated to messaging). */
export const inertMessaging: MessagingDependencies = {
  createEngine: () => new Promise<never>(() => undefined),
  createRealtime: () => new FakeRealtime(),
  destroyLocalData: () => Promise.resolve(),
};
