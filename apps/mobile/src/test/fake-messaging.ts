import type {
  PeerKeyStatus,
  CallAck,
  CallMediaPlatform,
  CallRequestName,
  Draft,
  GroupSecurityEvent,
  LocalMessage,
  MessagingEvent,
  OutgoingAttachment,
  TimelineEvent,
} from '@ogc/messaging';
import type { ConversationView, OgcId, ReactionType, ServerToClientEvents } from '@ogc/types';
import type { AttachmentDescriptor } from '@ogc/validation';
import { jest } from '@jest/globals';
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
    group: null,
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
  start = jest.fn(() => Promise.resolve());
  conversations = () => this.list;
  conversation = (id: string) => this.list.find((c) => c.id === id);
  refreshConversations = jest.fn(() => {
    this.emit({ type: 'conversations' });
    return Promise.resolve(this.list);
  });
  openDirect = jest.fn((ogcId: string) => {
    const existing =
      this.list.find((c) => c.peer?.ogcId === ogcId) ??
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
  events = new Map<string, TimelineEvent[]>();
  timeline = (conversationId: string) =>
    Promise.resolve([...(this.events.get(conversationId) ?? [])]);
  /** Group security changes reported per conversation (tests set them). */
  security = new Map<string, GroupSecurityEvent[]>();
  groupSecurity = (conversationId: string) =>
    Promise.resolve([...(this.security.get(conversationId) ?? [])]);
  dispose = jest.fn();
  /** Conversations waiting for another device (tests set them). */
  waitingForDevice = new Set<string>();
  awaitingAnotherDevice = jest.fn((conversationId: string) =>
    this.waitingForDevice.has(conversationId),
  );
  acknowledgeGroupSecurity = jest.fn((conversationId: string) => {
    this.security.set(
      conversationId,
      (this.security.get(conversationId) ?? []).map((e) => ({ ...e, acknowledged: true })),
    );
    this.emit({ type: 'security', conversationId });
    return Promise.resolve();
  });
  forgetConversation = jest.fn((conversationId: string) => {
    this.list = this.list.filter((c) => c.id !== conversationId);
    this.data.delete(conversationId);
    this.emit({ type: 'removed', conversationId });
    this.emit({ type: 'conversations' });
    return Promise.resolve();
  });
  syncConversation = jest.fn(() => Promise.resolve());
  syncAll = jest.fn(() => Promise.resolve(0));
  send = jest.fn((conversationId: string, draft: Draft & { forwardedFromId?: string }) => {
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
  edit = jest.fn((conversationId: string, messageId: string, text: string) => {
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
  deleteForEveryone = jest.fn((conversationId: string, messageId: string) => {
    this.data.set(
      conversationId,
      (this.data.get(conversationId) ?? []).map((m) =>
        m.id === messageId ? { ...m, state: 'deleted' as const, payload: null } : m,
      ),
    );
    this.emit({ type: 'messages', conversationId });
    return Promise.resolve();
  });
  deleteForMe = jest.fn((conversationId: string, messageId: string) => {
    this.data.set(
      conversationId,
      (this.data.get(conversationId) ?? []).filter((m) => m.id !== messageId),
    );
    this.emit({ type: 'messages', conversationId });
    return Promise.resolve();
  });
  react = jest.fn(
    (_conversationId: string, _messageId: string, _reaction: ReactionType, _add: boolean) =>
      Promise.resolve(),
  );
  markRead = jest.fn(() => Promise.resolve());
  forward = jest.fn((_from: string, _messageId: string, target: string) =>
    this.send(target, { text: 'forwarded' }),
  );
  uploadAttachment = jest.fn(
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
  openAttachment = jest.fn((descriptor: AttachmentDescriptor) => {
    const bytes = this.attachments.get(descriptor.id);
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('missing'));
  });
  search = jest.fn((query: string) =>
    Promise.resolve(
      [...this.data.values()]
        .flat()
        .filter((m) => m.payload?.text?.toLowerCase().includes(query.toLowerCase())),
    ),
  );
  /** Key-change state reported for the other person (tests set it). */
  peerKeys: PeerKeyStatus = { state: 'unverified', added: 0 };
  peerKeyStatus = jest.fn(() => Promise.resolve(this.peerKeys));
  acknowledgePeerKeys = jest.fn(() => {
    this.peerKeys = { state: 'unverified', added: 0 };
    return Promise.resolve();
  });
  markPeerVerified = jest.fn(() => {
    this.peerKeys = { state: 'verified', added: 0 };
    return Promise.resolve();
  });
  safetyNumber = jest.fn(() =>
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
  flushOutbox = jest.fn(() => Promise.resolve(0));
  discardFailed = jest.fn(() => Promise.resolve());
  handleRealtime = jest.fn();
  wipe = jest.fn(() => Promise.resolve());
}

export class FakeRealtime implements RealtimeLink {
  typingCalls: [string, boolean][] = [];
  connect = jest.fn();
  disconnect = jest.fn();
  typing = (conversationId: string, typing: boolean) => {
    this.typingCalls.push([conversationId, typing]);
  };
  subscribePresence = jest.fn((ogcIds: OgcId[]) =>
    Promise.resolve(ogcIds.map((ogcId) => ({ ogcId, state: 'ONLINE' as const }))),
  );
  unsubscribePresence = jest.fn();
  /** Call signaling sent by the app, and scripted acknowledgements (default: ok, null). */
  callRequests: { event: CallRequestName; payload: unknown }[] = [];
  callReplies = new Map<CallRequestName, (payload: unknown) => unknown>();
  callRequest = <E extends CallRequestName>(event: E, payload: unknown): Promise<CallAck<E>> => {
    this.callRequests.push({ event, payload });
    const reply = this.callReplies.get(event);
    return Promise.resolve((reply ? reply(payload) : { ok: true, data: null }) as CallAck<E>);
  };
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

export function fakeMessaging(
  engine = new FakeEngine(),
  callMedia?: CallMediaPlatform,
): FakeMessaging {
  const realtime = new FakeRealtime();
  const destroyed: string[] = [];
  let deliver: FakeMessaging['push'] = () => undefined;
  let state: (value: 'online' | 'offline' | 'connecting') => void = () => undefined;
  const dependencies: MessagingDependencies = {
    createEngine: () => Promise.resolve(engine),
    createRealtime: (_client, options, onEvent) => {
      deliver = onEvent;
      state = options.onState ?? (() => undefined);
      return realtime;
    },
    destroyLocalData: (ogcId) => {
      destroyed.push(ogcId);
      return Promise.resolve();
    },
    createCallMedia: () => callMedia,
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
