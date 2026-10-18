import {
  type AttachmentSecret,
  type DirectoryDevice as CryptoDirectoryDevice,
  type GeneratedKeyPackage,
  type LocalDevice,
  MlsGroup,
  MlsSoleMemberError,
  decryptAttachment,
  editAad,
  encryptAttachment,
  fromBase64,
  generateKeyPackages,
  generateSigningKeyPair,
  inspectWelcome,
  messageAad,
  safetyNumber,
  toBase64,
  wipeConsumed,
} from '@ogc/e2ee';
import type {
  AttachmentKind,
  ClaimedKeyPackage,
  ConversationEventView,
  ConversationView,
  DirectoryDevice,
  MessageView,
  NotificationView,
  ReactionType,
  ReceivedInvitationView,
  ServerToClientEvents,
  SyncItem,
} from '@ogc/types';
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentDescriptor,
  type MessagePayload,
  messagePayloadSchema,
} from '@ogc/validation';
import {
  type GroupSecurityEvent,
  type GroupSecurityRecord,
  type GroupTransition,
  acknowledgeGroup,
  baselineGroup,
  reconcileGroup,
} from './group-security.js';
import {
  type PeerKeyRecord,
  type PeerKeyStatus,
  acknowledgePeerKeys,
  reconcilePeerKeys,
  verifyPeerKeys,
} from './key-tracking.js';
import { KeyedLock } from './lock.js';
import {
  type LocalMessage,
  decodePayload,
  encodePayload,
  fromServer,
  searchable,
} from './payload.js';
import type { SealedStore } from './store.js';
import { type MessagingTransport, TransportError, errorCode, isRetryable } from './transport.js';

/** Keep at least this many unused key packages on the server… */
const KEY_PACKAGES_LOW_WATER = 10;
/** …topping up to this many. */
const KEY_PACKAGES_TARGET = 30;
const MAX_EPOCH_RETRIES = 3;
const BUCKET = 100;
/** The device directory is re-fetched at most this often (invalidated on device changes). */
const DIRECTORY_CACHE_MS = 5_000;
/** The server accepts at most this many devices per key-package claim. */
const CLAIM_BATCH = 50;
/** Timeline events (joins, role changes…) kept per conversation on this device. */
const TIMELINE_MAX = 500;
/** Wait used when a rate-limited resync carries no `Retry-After`, and the longest honoured. */
const RESYNC_RETRY_DEFAULT_S = 60;
const RESYNC_RETRY_MAX_S = 24 * 60 * 60;

interface StoredIdentity {
  ogcId: string;
  deviceKeyId: string;
  publicKey: string;
  privateKey: string;
}

interface ConversationMeta {
  /** Highest conversation version this device has applied. */
  cursor: number;
  /** MLS epoch at which this device joined; earlier messages cannot be decrypted here. */
  joinEpoch: number;
  /** Highest peer message seq acknowledged as delivered. */
  deliveredSeq: number;
}

export type MessagingEvent =
  | { type: 'conversations' }
  | { type: 'messages'; conversationId: string }
  /** The account is no longer in this conversation (removed, left, deleted); local data was erased. */
  | { type: 'removed'; conversationId: string }
  | { type: 'invitations'; invitation?: ReceivedInvitationView }
  | { type: 'notification'; notification: NotificationView }
  /** A community channel changed (channels are server-readable and not managed by this engine). */
  | { type: 'channel'; channelId: string; event: keyof ServerToClientEvents; postId?: string }
  /** A group's cryptographic membership changed in a way that needs the person's attention. */
  | { type: 'security'; conversationId: string }
  /** The conversation started or stopped waiting for another device (see `awaitingAnotherDevice`). */
  | { type: 'recovery'; conversationId: string }
  | { type: 'error'; conversationId?: string; error: unknown };

/** A membership or settings change in a group's timeline, with its position. */
export interface TimelineEvent extends ConversationEventView {
  version: number;
}

export interface OutgoingAttachment {
  kind: AttachmentKind;
  name: string;
  mime: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
}

export interface Draft {
  text?: string;
  attachments?: AttachmentDescriptor[];
  replyToId?: string;
  /**
   * Group members mentioned in the text (OGC IDs). Sent beside the ciphertext
   * so the server can notify them without reading the message.
   */
  mentions?: string[];
}

export class MessagingError extends Error {
  override readonly name: string = 'MessagingError';
}

/**
 * This device lost its group state while it is the conversation's only device in the group, and
 * the MLS library cannot resync a sole member. Recoverable: it waits until another device joins
 * (messages stay pending meanwhile). Not a security failure.
 */
export class ConversationWaitingError extends MessagingError {
  override readonly name = 'ConversationWaitingError';

  constructor() {
    super('Encryption is waiting for another device to join this conversation');
  }
}

/**
 * The server rate-limited this device's resync for the conversation (`MLS_RESYNC_RATE_LIMITED`),
 * and the engine is waiting out its `Retry-After`. Temporary: the conversation's outgoing
 * messages stay pending, and one recovery attempt follows when the pause ends.
 */
export class ResyncPausedError extends MessagingError {
  override readonly name = 'ResyncPausedError';

  constructor(
    readonly resumesAt: number,
    now: number,
  ) {
    super(
      `Restoring encryption for this conversation is paused; it resumes in ${String(
        Math.max(1, Math.ceil((resumesAt - now) / 1000)),
      )} s`,
    );
  }
}

/** The engine was disposed (sign-out, account change, provider unmount): it does no more work. */
export class EngineDisposedError extends MessagingError {
  override readonly name = 'EngineDisposedError';

  constructor() {
    super('This messaging engine has been shut down');
  }
}

/**
 * The engine's view of the transport: once disposed, every request is refused before it is
 * made, so work still in flight (a recovery, a flush) stops at its next network step. Methods
 * are looked up on each call, so the underlying transport object stays the single source.
 */
function guardedTransport(
  transport: MessagingTransport,
  isDisposed: () => boolean,
): MessagingTransport {
  return new Proxy(transport, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (isDisposed()) return Promise.reject(new EngineDisposedError());
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * A temporary MLS resync rate limit (the server's structured code, or the engine's own pause) —
 * never any other 429, such as the general request throttle.
 */
function isResyncPause(error: unknown): boolean {
  return error instanceof ResyncPausedError || errorCode(error) === 'MLS_RESYNC_RATE_LIMITED';
}

/** Timer source (tests substitute a deterministic one). */
export interface EngineTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: EngineTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // Node only: a pending retry must not keep a process (or test run) alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const metaKey = (c: string): string => `meta:${c}`;
const groupKey = (c: string): string => `group:${c}`;
const bucketKey = (c: string, seq: number): string =>
  `msgs:${c}:${String(Math.floor(seq / BUCKET)).padStart(12, '0')}`;
const pendingKey = (c: string): string => `pending:${c}`;
const kpKey = (ref: string): string => `kp:${ref}`;
const timelineKey = (c: string): string => `timeline:${c}`;
/** Device keys last accepted for a person (key-change detection). */
const peerKeysKey = (ogcId: string): string => `peerkeys:${ogcId}`;
/** The group's MLS tree last accepted on this device and its security changes. */
const groupSecurityKey = (c: string): string => `groupsec:${c}`;

function toCryptoDirectory(devices: DirectoryDevice[]): CryptoDirectoryDevice[] {
  return devices.map((d) => ({
    ogcId: d.ogcId,
    deviceKeyId: d.deviceKeyId,
    signaturePublicKey: fromBase64(d.signaturePublicKey),
  }));
}

/**
 * The OGC end-to-end encrypted messaging engine (one per signed-in device).
 *
 * It owns the device's MLS identity and per-conversation group state, keeps
 * a sealed local copy of decrypted messages, and turns the server's ordered
 * change log into local state. Plaintext exists only inside this engine and
 * the UI; everything sent to the server is MLS ciphertext or public MLS data.
 * See docs/architecture/encryption.md and sync.md.
 */
export class MessagingClient {
  private readonly lock = new KeyedLock();
  /**
   * Serializes every change to a conversation's outbox record (a read-modify-write of one sealed
   * value). A leaf lock: held only around that read and write, never while taking the
   * conversation lock, so the order is always conversation lock → outbox lock (no deadlock).
   */
  private readonly outboxLock = new KeyedLock();
  private readonly listeners = new Set<(event: MessagingEvent) => void>();
  private readonly scheduledSyncs = new Map<string, Promise<void>>();
  private identity: LocalDevice | undefined;
  private conversationCache = new Map<string, ConversationView>();
  private readonly directoryCache = new Map<string, { at: number; devices: DirectoryDevice[] }>();
  /**
   * Conversations waiting for another device (sole member without group state). In memory only:
   * after a restart the first attempt finds out again. `armed`: a membership event allows one
   * attempt, which re-checks the published group first.
   */
  private readonly recovery = new Map<string, 'waiting' | 'armed'>();
  /** Conversations whose resync the server rate-limited: when to retry, and the one retry timer. */
  private readonly resyncPaused = new Map<string, { until: number; timer: unknown }>();

  private readonly transport: MessagingTransport;
  /** Set by `dispose()`; never cleared. */
  private disposed = false;

  constructor(
    transport: MessagingTransport,
    private readonly store: SealedStore,
    readonly ogcId: string,
    private readonly timers: EngineTimers = systemTimers,
  ) {
    this.transport = guardedTransport(transport, () => this.disposed);
  }

  /**
   * Shuts the engine down (sign-out, account change, provider unmount). Idempotent. Clears every
   * pending retry timer, stops events, and refuses all further network requests — so recovery or
   * flushing still in flight stops at its next step. Local data is kept: queued (pending)
   * messages stay in the sealed outbox for the next engine on this device. `wipe()` erases it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { timer } of this.resyncPaused.values()) this.timers.clearTimeout(timer);
    this.resyncPaused.clear();
    this.recovery.clear();
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get deviceKeyId(): string | undefined {
    return this.identity?.deviceKeyId;
  }

  subscribe(listener: (event: MessagingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MessagingEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(event);
  }

  // -------------------------------------------------------------------------
  // Device identity and key packages
  // -------------------------------------------------------------------------

  /** Loads or creates this device's identity, tops up key packages and joins pending groups. */
  async start(): Promise<void> {
    this.identity = await this.loadOrCreateIdentity();
    await this.replenishKeyPackages();
    await this.processWelcomes();
    const cached = await this.store.getJson<ConversationView[]>('conversations');
    if (cached) this.conversationCache = new Map(cached.map((c) => [c.id, c]));
  }

  private async loadOrCreateIdentity(): Promise<LocalDevice> {
    const stored = await this.store.getJson<StoredIdentity>('identity');
    const server = await this.transport.currentDeviceKey();
    if (stored?.ogcId === this.ogcId) {
      if (server?.deviceKeyId === stored.deviceKeyId) return this.toDevice(stored);
      try {
        const registered = await this.transport.registerDeviceKey(stored.publicKey);
        if (registered.deviceKeyId === stored.deviceKeyId) return this.toDevice(stored);
      } catch (error) {
        if (errorCode(error) !== 'CONFLICT') throw error;
      }
    }
    // No usable identity (first run, another account, or the server no longer
    // recognises it): start over with fresh keys and no local group state.
    await this.store.clear();
    const signing = await generateSigningKeyPair();
    const registered = await this.transport.registerDeviceKey(toBase64(signing.publicKey));
    const identity: StoredIdentity = {
      ogcId: this.ogcId,
      deviceKeyId: registered.deviceKeyId,
      publicKey: toBase64(signing.publicKey),
      privateKey: toBase64(signing.privateKey),
    };
    await this.store.setJson('identity', identity);
    return this.toDevice(identity);
  }

  private toDevice(stored: StoredIdentity): LocalDevice {
    return {
      ogcId: stored.ogcId,
      deviceKeyId: stored.deviceKeyId,
      signing: {
        publicKey: fromBase64(stored.publicKey),
        privateKey: fromBase64(stored.privateKey),
      },
    };
  }

  private requireIdentity(): LocalDevice {
    if (!this.identity) throw new MessagingError('Messaging has not started');
    return this.identity;
  }

  async replenishKeyPackages(): Promise<void> {
    const identity = this.requireIdentity();
    const status = await this.transport.currentDeviceKey();
    const available = status?.keyPackagesAvailable ?? 0;
    if (available >= KEY_PACKAGES_LOW_WATER) return;
    const fresh = await generateKeyPackages(identity, KEY_PACKAGES_TARGET - available);
    // Store the private halves first: a Welcome may arrive as soon as they are published.
    for (const kp of fresh) await this.store.setJson(kpKey(kp.ref), kp);
    await this.transport.uploadKeyPackages(fresh.map((kp) => kp.publicKey));
  }

  /** Joins every conversation group this device was added to while away. */
  async processWelcomes(): Promise<void> {
    const welcomes = await this.transport.welcomes();
    for (const welcome of welcomes) {
      await this.lock.run(welcome.conversationId, async () => {
        const existing = await this.loadGroup(welcome.conversationId);
        if (existing && existing.epoch >= BigInt(welcome.epoch)) {
          await this.transport.acknowledgeWelcome(welcome.id);
          return;
        }
        const refs = inspectWelcome(welcome.welcome).keyPackageRefs;
        let keyPackage: GeneratedKeyPackage | undefined;
        for (const ref of refs) {
          keyPackage ??= await this.store.getJson<GeneratedKeyPackage>(kpKey(ref));
        }
        if (keyPackage) {
          const directory = toCryptoDirectory(await this.directory(welcome.conversationId));
          const group = await MlsGroup.joinFromWelcome(welcome.welcome, keyPackage, directory);
          await this.saveGroup(welcome.conversationId, group);
          await this.trackGroup(welcome.conversationId, undefined, group, { kind: 'join' });
          const meta = await this.meta(welcome.conversationId);
          await this.saveMeta(welcome.conversationId, { ...meta, joinEpoch: Number(group.epoch) });
          await this.store.delete(kpKey(keyPackage.ref));
        }
        await this.transport.acknowledgeWelcome(welcome.id);
      });
      void this.scheduleSync(welcome.conversationId);
    }
    if (welcomes.length > 0) await this.replenishKeyPackages();
  }

  // -------------------------------------------------------------------------
  // Local state
  // -------------------------------------------------------------------------

  private async meta(conversationId: string): Promise<ConversationMeta> {
    return (
      (await this.store.getJson<ConversationMeta>(metaKey(conversationId))) ?? {
        cursor: 0,
        joinEpoch: 0,
        deliveredSeq: 0,
      }
    );
  }

  private saveMeta(conversationId: string, meta: ConversationMeta): Promise<void> {
    return this.store.setJson(metaKey(conversationId), meta);
  }

  /** The conversation's device directory (cached briefly). */
  private async directory(conversationId: string): Promise<DirectoryDevice[]> {
    const cached = this.directoryCache.get(conversationId);
    if (cached && Date.now() - cached.at < DIRECTORY_CACHE_MS) return cached.devices;
    const devices = await this.transport.directory(conversationId);
    this.directoryCache.set(conversationId, { at: Date.now(), devices });
    return devices;
  }

  private async loadGroup(conversationId: string): Promise<MlsGroup | undefined> {
    const bytes = await this.store.getBytes(groupKey(conversationId));
    if (!bytes) return undefined;
    const directory = toCryptoDirectory(await this.directory(conversationId));
    return MlsGroup.restore(bytes, directory);
  }

  private saveGroup(conversationId: string, group: MlsGroup): Promise<void> {
    return this.store.setBytes(groupKey(conversationId), group.serialize());
  }

  private async readBucket(key: string): Promise<LocalMessage[]> {
    return (await this.store.getJson<LocalMessage[]>(key)) ?? [];
  }

  /** Inserts or replaces a message (matched by client message ID) in its seq bucket. */
  private async putMessage(message: LocalMessage): Promise<void> {
    if (message.seq === null) throw new MessagingError('Stored messages need a sequence number');
    const key = bucketKey(message.conversationId, message.seq);
    const bucket = (await this.readBucket(key)).filter(
      (m) => m.clientMessageId !== message.clientMessageId,
    );
    bucket.push(message);
    bucket.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    await this.store.setJson(key, bucket);
  }

  private async findStored(
    conversationId: string,
    seq: number,
    clientMessageId: string,
  ): Promise<LocalMessage | undefined> {
    return (await this.readBucket(bucketKey(conversationId, seq))).find(
      (m) => m.clientMessageId === clientMessageId,
    );
  }

  private async findById(
    conversationId: string,
    messageId: string,
  ): Promise<LocalMessage | undefined> {
    for (const key of await this.store.keys(`msgs:${conversationId}:`)) {
      const found = (await this.readBucket(key)).find((m) => m.id === messageId);
      if (found) return found;
    }
    return undefined;
  }

  private async removeMessage(conversationId: string, messageId: string): Promise<void> {
    for (const key of await this.store.keys(`msgs:${conversationId}:`)) {
      const bucket = await this.readBucket(key);
      const kept = bucket.filter((m) => m.id !== messageId);
      if (kept.length !== bucket.length) {
        await this.store.setJson(key, kept);
        return;
      }
    }
  }

  private async pending(conversationId: string): Promise<LocalMessage[]> {
    return (await this.store.getJson<LocalMessage[]>(pendingKey(conversationId))) ?? [];
  }

  /**
   * Changes a conversation's outbox: `change` gets the current list (read inside the lock) and
   * returns the new one, which is written before the lock is released. Every outbox write goes
   * through here, so concurrent changes can never overwrite each other. Storage errors propagate.
   */
  private updatePending(
    conversationId: string,
    change: (messages: LocalMessage[]) => LocalMessage[],
  ): Promise<LocalMessage[]> {
    return this.outboxLock.run(conversationId, async () => {
      const next = change(await this.pending(conversationId));
      if (next.length === 0) await this.store.delete(pendingKey(conversationId));
      else await this.store.setJson(pendingKey(conversationId), next);
      return next;
    });
  }

  private withoutPending(conversationId: string, clientMessageId: string): Promise<LocalMessage[]> {
    return this.updatePending(conversationId, (messages) =>
      messages.filter((m) => m.clientMessageId !== clientMessageId),
    );
  }

  /** The newest `limit` messages of a conversation (oldest first), followed by unsent ones. */
  async messages(conversationId: string, limit = 200): Promise<LocalMessage[]> {
    const keys = (await this.store.keys(`msgs:${conversationId}:`)).sort().reverse();
    const collected: LocalMessage[] = [];
    for (const key of keys) {
      collected.unshift(...(await this.readBucket(key)));
      if (collected.length >= limit) break;
    }
    return [...collected.slice(-limit), ...(await this.pending(conversationId))];
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  conversations(): ConversationView[] {
    return [...this.conversationCache.values()].sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }

  conversation(id: string): ConversationView | undefined {
    return this.conversationCache.get(id);
  }

  /** Reloads the conversation list (first pages) and caches it for offline display. */
  async refreshConversations(maxPages = 5): Promise<ConversationView[]> {
    const fresh = new Map<string, ConversationView>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.transport.listConversations(cursor);
      for (const c of result.items) fresh.set(c.id, c);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    this.conversationCache = fresh;
    await this.persistConversations();
    this.emit({ type: 'conversations' });
    return this.conversations();
  }

  private async persistConversations(): Promise<void> {
    await this.store.setJson('conversations', [...this.conversationCache.values()]);
  }

  private async refreshConversation(id: string): Promise<ConversationView> {
    const view = await this.transport.conversation(id);
    this.conversationCache.set(id, view);
    await this.persistConversations();
    this.emit({ type: 'conversations' });
    return view;
  }

  async openDirect(ogcId: string): Promise<ConversationView> {
    const view = await this.transport.openConversation(ogcId);
    this.conversationCache.set(view.id, view);
    await this.persistConversations();
    this.emit({ type: 'conversations' });
    return view;
  }

  /**
   * Catches up after being offline: fetches the conversations that changed
   * since the last run and syncs each one. Returns how many were synced.
   */
  async syncAll(): Promise<number> {
    const since = await this.store.getJson<string>('changes-cursor');
    let cursor = since ?? undefined;
    let synced = 0;
    for (;;) {
      const page = await this.transport.conversationChanges(cursor);
      for (const conversation of page.items) {
        this.conversationCache.set(conversation.id, conversation);
        const meta = await this.meta(conversation.id);
        if (conversation.version > meta.cursor) {
          try {
            await this.syncConversation(conversation.id);
            synced++;
          } catch (error) {
            // A rate-limited resync is retried by its own timer; the others still sync.
            if (!isResyncPause(error)) throw error;
          }
        }
      }
      cursor = page.cursor;
      await this.store.setJson('changes-cursor', cursor);
      if (!page.hasMore) break;
    }
    await this.persistConversations();
    this.emit({ type: 'conversations' });
    await this.processWelcomes();
    await this.flushOutbox();
    return synced;
  }

  // -------------------------------------------------------------------------
  // MLS group lifecycle
  // -------------------------------------------------------------------------

  /** Returns this device's group for the conversation, creating or joining it if needed. */
  private async ensureGroup(conversationId: string): Promise<MlsGroup> {
    const identity = this.requireIdentity();
    for (let attempt = 0; attempt < MAX_EPOCH_RETRIES; attempt++) {
      const existing = await this.loadGroup(conversationId);
      if (existing) {
        if (this.recovery.has(conversationId)) this.resolveRecovery(conversationId);
        return existing;
      }
      // Waiting for another device: no request at all until a membership event arms an attempt.
      const waiting = this.recovery.get(conversationId);
      if (waiting === 'waiting') throw new ConversationWaitingError();
      // A resync the server rate-limited waits for its retry time: no request at all until then.
      const paused = this.resyncPaused.get(conversationId);
      if (paused && this.timers.now() < paused.until) {
        throw new ResyncPausedError(paused.until, this.timers.now());
      }
      const server = await this.transport.mlsGroup(conversationId);
      if (waiting === 'armed') {
        // Re-check first: if this device is still the group's only member, nothing can be done
        // (this server view only ever skips an attempt; joining verifies the published tree).
        if (server.members.length === 1 && server.members[0] === identity.deviceKeyId) {
          this.waitForAnotherDevice(conversationId);
          throw new ConversationWaitingError();
        }
        this.recovery.delete(conversationId);
      }
      const listed = await this.directory(conversationId);
      const directory = toCryptoDirectory(listed);
      try {
        if (server.epoch === 0 || !server.groupInfo) {
          // First device to message: create the group and add every other device we can.
          const created = await MlsGroup.create(identity, conversationId, directory);
          const others = listed.filter((d) => d.active && d.deviceKeyId !== identity.deviceKeyId);
          const claimed = await this.claimAll(
            conversationId,
            others.map((d) => d.deviceKeyId),
          );
          const result = await created.commit({ add: claimed.map((c) => c.keyPackage) });
          await this.transport.submitCommit(conversationId, {
            epoch: 0,
            commit: result.commit,
            groupInfo: result.groupInfo,
            ...(result.welcome ? { welcome: result.welcome } : {}),
          });
          wipeConsumed(result.consumed);
          await this.saveGroup(conversationId, result.group);
          await this.trackGroup(conversationId, created, result.group, { kind: 'own-commit' });
          await this.saveMeta(conversationId, {
            ...(await this.meta(conversationId)),
            joinEpoch: Number(result.group.epoch),
          });
          return result.group;
        }
        // The group exists: we may have been added while away…
        const pendingWelcome = (await this.transport.welcomes()).some(
          (w) => w.conversationId === conversationId,
        );
        if (pendingWelcome) {
          await this.processWelcomesUnlocked(conversationId);
          continue;
        }
        // …otherwise join by ourselves from the published GroupInfo (external commit; a resync
        // if the tree still holds this device). Every leaf of that tree is checked against the
        // directory, so fetch it fresh: the cached copy may predate a newly added device.
        this.directoryCache.delete(conversationId);
        const fresh = toCryptoDirectory(await this.directory(conversationId));
        const joined = await MlsGroup.joinExternal(identity, server.groupInfo, fresh);
        await this.transport.submitCommit(conversationId, {
          epoch: server.epoch,
          commit: joined.commit,
          groupInfo: joined.groupInfo,
        });
        await this.saveGroup(conversationId, joined.group);
        await this.trackGroup(conversationId, undefined, joined.group, { kind: 'join' });
        await this.saveMeta(conversationId, {
          ...(await this.meta(conversationId)),
          joinEpoch: Number(joined.group.epoch),
        });
        if (waiting) this.resolveRecovery(conversationId);
        else {
          // Messages queued while there was no group (e.g. during a rate-limited resync) go out
          // now, after the current (locked) operation; each is re-checked under the lock.
          void Promise.resolve().then(() => this.flushConversation(conversationId));
        }
        return joined.group;
      } catch (error) {
        if (error instanceof MlsSoleMemberError) {
          this.waitForAnotherDevice(conversationId);
          throw new ConversationWaitingError();
        }
        if (errorCode(error) === 'MLS_RESYNC_RATE_LIMITED' && error instanceof TransportError) {
          this.pauseResync(conversationId, error.retryAfterSeconds);
        }
        if (errorCode(error) !== 'STALE_EPOCH') throw error;
      }
    }
    throw new MessagingError('Could not establish the secure session; try again');
  }

  /**
   * True while the conversation waits for another device to join before encryption can resume
   * (this device is the group's only member and lost its group state). Its outgoing messages stay
   * pending meanwhile; other conversations are unaffected.
   */
  awaitingAnotherDevice(conversationId: string): boolean {
    return this.recovery.has(conversationId);
  }

  private waitForAnotherDevice(conversationId: string): void {
    // Only a conversation that was not waiting before is news (armed → waiting is not).
    const started = !this.recovery.has(conversationId);
    this.recovery.set(conversationId, 'waiting');
    if (started) this.emit({ type: 'recovery', conversationId });
  }

  /** A membership or device change may have brought another device: allow one attempt. */
  private armRecovery(conversationId: string): void {
    if (this.recovery.get(conversationId) === 'waiting') this.recovery.set(conversationId, 'armed');
  }

  /** The conversation has a group again: stop waiting and send what was queued meanwhile. */
  private resolveRecovery(conversationId: string): void {
    this.recovery.delete(conversationId);
    this.emit({ type: 'recovery', conversationId });
    // After the current (locked) operation: deliver takes the conversation lock itself.
    void Promise.resolve().then(() => this.flushConversation(conversationId));
  }

  /** Sends one conversation's pending messages; failures stay as `deliver` leaves them. */
  private async flushConversation(conversationId: string): Promise<void> {
    if (this.disposed) return;
    for (const message of await this.pending(conversationId)) {
      if (message.state !== 'pending') continue;
      try {
        const result = await this.deliverIfPending(conversationId, message.clientMessageId);
        if (result && result.state !== 'ok') return;
      } catch {
        return;
      }
    }
  }

  /**
   * Delivers a queued message if it is still pending once the conversation lock is held — a
   * concurrent send or flush may have delivered it meanwhile, and it must be submitted once.
   */
  private deliverIfPending(
    conversationId: string,
    clientMessageId: string,
  ): Promise<LocalMessage | undefined> {
    return this.lock.run(conversationId, async () => {
      const message = (await this.pending(conversationId)).find(
        (m) => m.clientMessageId === clientMessageId && m.state === 'pending',
      );
      return message ? this.deliver(message) : undefined;
    });
  }

  /**
   * When this conversation's resync may be tried again (epoch ms), if the server rate-limited it.
   * Other conversations are not affected.
   */
  resyncPausedUntil(conversationId: string): number | undefined {
    const paused = this.resyncPaused.get(conversationId);
    return paused && this.timers.now() < paused.until ? paused.until : undefined;
  }

  /** Waits out a rate-limited resync, then syncs (and so retries) once — one timer per conversation. */
  private pauseResync(conversationId: string, retryAfterSeconds: number | undefined): void {
    if (this.disposed) return;
    const seconds = Math.min(
      Math.max(retryAfterSeconds ?? RESYNC_RETRY_DEFAULT_S, 1),
      RESYNC_RETRY_MAX_S,
    );
    // A new server answer replaces the previous pause (and its timer): never two timers.
    const existing = this.resyncPaused.get(conversationId);
    if (existing) this.timers.clearTimeout(existing.timer);
    const timer = this.timers.setTimeout(() => {
      this.resyncPaused.delete(conversationId);
      if (this.disposed) return;
      void this.scheduleSync(conversationId);
    }, seconds * 1000);
    this.resyncPaused.set(conversationId, { until: this.timers.now() + seconds * 1000, timer });
  }

  /** Claims key packages in batches the server accepts. Devices without packages are skipped. */
  private async claimAll(
    conversationId: string,
    deviceKeyIds: string[],
  ): Promise<ClaimedKeyPackage[]> {
    const claimed: ClaimedKeyPackage[] = [];
    for (let i = 0; i < deviceKeyIds.length; i += CLAIM_BATCH) {
      claimed.push(
        ...(await this.transport.claimKeyPackages(
          conversationId,
          deviceKeyIds.slice(i, i + CLAIM_BATCH),
        )),
      );
    }
    return claimed;
  }

  /** Welcome processing for one conversation while its lock is already held. */
  private async processWelcomesUnlocked(conversationId: string): Promise<void> {
    for (const welcome of await this.transport.welcomes()) {
      if (welcome.conversationId !== conversationId) continue;
      const refs = inspectWelcome(welcome.welcome).keyPackageRefs;
      let keyPackage: GeneratedKeyPackage | undefined;
      for (const ref of refs)
        keyPackage ??= await this.store.getJson<GeneratedKeyPackage>(kpKey(ref));
      if (keyPackage && !(await this.store.getBytes(groupKey(conversationId)))) {
        const directory = toCryptoDirectory(await this.directory(conversationId));
        const group = await MlsGroup.joinFromWelcome(welcome.welcome, keyPackage, directory);
        await this.saveGroup(conversationId, group);
        await this.trackGroup(conversationId, undefined, group, { kind: 'join' });
        await this.saveMeta(conversationId, {
          ...(await this.meta(conversationId)),
          joinEpoch: Number(group.epoch),
        });
        await this.store.delete(kpKey(keyPackage.ref));
      }
      await this.transport.acknowledgeWelcome(welcome.id);
    }
  }

  /**
   * Makes the group's membership match the device directory: adds the
   * participants' new devices and removes devices that are no longer active —
   * including every device of someone who left or was removed from a group.
   */
  async reconcile(conversationId: string): Promise<void> {
    try {
      await this.lock.run(conversationId, () => this.reconcileUnlocked(conversationId, true));
    } catch (error) {
      // Nothing to reconcile while the conversation waits for another device.
      if (!(error instanceof ConversationWaitingError)) throw error;
    }
  }

  private async reconcileUnlocked(conversationId: string, force: boolean): Promise<void> {
    if (!force) {
      // Cheap pre-send check: a fresh directory against the local group, no commit unless needed.
      const group = await this.ensureGroup(conversationId);
      this.directoryCache.delete(conversationId);
      const directory = await this.directory(conversationId);
      const members = new Set(group.members().map((m) => m.deviceKeyId));
      const active = directory.filter((d) => d.active).map((d) => d.deviceKeyId);
      const inSync =
        active.every((id) => members.has(id)) && [...members].every((id) => active.includes(id));
      if (inSync) return;
    }
    for (let attempt = 0; attempt < MAX_EPOCH_RETRIES; attempt++) {
      await this.ensureGroup(conversationId);
      await this.syncUnlocked(conversationId);
      this.directoryCache.delete(conversationId);
      const group = await this.loadGroup(conversationId);
      if (!group) continue;
      const directory = await this.directory(conversationId);
      const active = new Set(directory.filter((d) => d.active).map((d) => d.deviceKeyId));
      const members = new Set(group.members().map((m) => m.deviceKeyId));
      const missing = [...active].filter((id) => !members.has(id));
      const stale = [...members].filter((id) => !active.has(id));
      const claimed = await this.claimAll(conversationId, missing);
      if (claimed.length === 0 && stale.length === 0) {
        return;
      }
      const result = await group.commit({
        add: claimed.map((c) => c.keyPackage),
        removeDeviceKeyIds: stale,
      });
      try {
        await this.transport.submitCommit(conversationId, {
          epoch: Number(group.epoch),
          commit: result.commit,
          groupInfo: result.groupInfo,
          ...(result.welcome ? { welcome: result.welcome } : {}),
        });
      } catch (error) {
        if (errorCode(error) === 'STALE_EPOCH') continue;
        throw error;
      }
      wipeConsumed(result.consumed);
      await this.saveGroup(conversationId, result.group);
      await this.trackGroup(conversationId, group, result.group, { kind: 'own-commit' });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Synchronization
  // -------------------------------------------------------------------------

  /** Applies everything that changed in a conversation since this device's cursor. */
  async syncConversation(conversationId: string): Promise<void> {
    await this.lock.run(conversationId, () => this.syncUnlocked(conversationId));
  }

  /** Coalesces bursts of realtime events into one sync per conversation. */
  scheduleSync(conversationId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.scheduledSyncs.get(conversationId);
    if (existing) return existing;
    const run = Promise.resolve()
      .then(() => {
        this.scheduledSyncs.delete(conversationId);
        return this.syncConversation(conversationId);
      })
      .catch((error: unknown) => {
        this.emit({ type: 'error', conversationId, error });
      });
    this.scheduledSyncs.set(conversationId, run);
    return run;
  }

  private async syncUnlocked(conversationId: string): Promise<void> {
    try {
      await this.syncPages(conversationId);
    } catch (error) {
      // Not (or no longer) a participant: removed, left on another device, or deleted.
      if (error instanceof TransportError && error.status === 404) {
        await this.forgetConversation(conversationId);
        return;
      }
      // Waiting for another device: nothing to sync here; other conversations carry on.
      if (error instanceof ConversationWaitingError) return;
      throw error;
    }
  }

  private async syncPages(conversationId: string): Promise<void> {
    let group = await this.loadGroup(conversationId);
    group ??= await this.ensureGroup(conversationId);
    let meta = await this.meta(conversationId);
    let highestPeerSeq = meta.deliveredSeq;
    let changed = false;
    let eventsSeen = false;
    for (;;) {
      const page = await this.transport.sync(conversationId, meta.cursor);
      for (const item of page.items) {
        group = await this.applyItem(conversationId, group, item);
        if (
          item.type === 'message' &&
          !item.message.deletedAt &&
          item.message.sender.ogcId !== this.ogcId
        ) {
          highestPeerSeq = Math.max(highestPeerSeq, item.message.seq);
        }
        if (item.type === 'event') eventsSeen = true;
        changed = true;
      }
      // Re-read: applying items may have re-joined the group (new join epoch).
      meta = { ...(await this.meta(conversationId)), cursor: page.version };
      await this.saveMeta(conversationId, meta);
      if (!page.hasMore) break;
    }
    if (highestPeerSeq > meta.deliveredSeq) {
      await this.transport.markDelivered(conversationId, highestPeerSeq);
      await this.saveMeta(conversationId, { ...meta, deliveredSeq: highestPeerSeq });
    }
    if (eventsSeen) await this.refreshConversation(conversationId);
    if (changed) this.emit({ type: 'messages', conversationId });
  }

  /** Erases everything this device holds about a conversation it can no longer access. */
  async forgetConversation(conversationId: string): Promise<void> {
    for (const key of await this.store.keys(`msgs:${conversationId}:`)) {
      await this.store.delete(key);
    }
    await this.store.delete(groupKey(conversationId));
    await this.store.delete(metaKey(conversationId));
    await this.updatePending(conversationId, () => []);
    await this.store.delete(timelineKey(conversationId));
    await this.store.delete(groupSecurityKey(conversationId));
    this.directoryCache.delete(conversationId);
    if (this.conversationCache.delete(conversationId)) await this.persistConversations();
    this.emit({ type: 'removed', conversationId });
    this.emit({ type: 'conversations' });
  }

  /**
   * Records how the group's MLS tree changed (see group-security.ts). Runs under the
   * conversation lock, after the new state is saved. `before` is the state the change was
   * applied to; without it (a join) the stored record is the reference.
   */
  private async trackGroup(
    conversationId: string,
    before: MlsGroup | undefined,
    after: MlsGroup,
    transition: GroupTransition,
  ): Promise<void> {
    const key = groupSecurityKey(conversationId);
    const tracked = (group: MlsGroup) =>
      group.members().map((m) => ({
        ogcId: m.ogcId,
        deviceKeyId: m.deviceKeyId,
        key: toBase64(m.signaturePublicKey),
      }));
    let stored = await this.store.getJson<GroupSecurityRecord>(key);
    if (!stored) {
      // First sight on this device (or data from before this feature): trust what is there.
      if (!before) {
        await this.store.setJson(key, baselineGroup(Number(after.epoch), tracked(after)));
        return;
      }
      stored = baselineGroup(Number(before.epoch), tracked(before));
    }
    const { record, added } = reconcileGroup(
      stored,
      Number(after.epoch),
      tracked(after),
      transition,
    );
    if (record !== stored) await this.store.setJson(key, record);
    if (added.some((e) => !e.acknowledged)) this.emit({ type: 'security', conversationId });
  }

  /**
   * Security-relevant changes to a group's encrypted membership seen by this device, oldest
   * first. Computed and stored only on this device, from its own MLS state.
   */
  async groupSecurity(conversationId: string): Promise<GroupSecurityEvent[]> {
    return (
      (await this.store.getJson<GroupSecurityRecord>(groupSecurityKey(conversationId)))?.events ??
      []
    );
  }

  /** The person reviewed the group's security changes (dismisses the warning). */
  async acknowledgeGroupSecurity(conversationId: string): Promise<void> {
    await this.lock.run(conversationId, async () => {
      const key = groupSecurityKey(conversationId);
      const stored = await this.store.getJson<GroupSecurityRecord>(key);
      if (stored) await this.store.setJson(key, acknowledgeGroup(stored));
    });
    this.emit({ type: 'security', conversationId });
  }

  /** Membership and settings events of a group, oldest first. */
  async timeline(conversationId: string): Promise<TimelineEvent[]> {
    return (await this.store.getJson<TimelineEvent[]>(timelineKey(conversationId))) ?? [];
  }

  private async appendTimeline(conversationId: string, event: TimelineEvent): Promise<void> {
    const existing = await this.timeline(conversationId);
    if (existing.some((e) => e.id === event.id)) return;
    await this.store.setJson(
      timelineKey(conversationId),
      [...existing, event].sort((a, b) => a.version - b.version).slice(-TIMELINE_MAX),
    );
  }

  private async applyItem(
    conversationId: string,
    group: MlsGroup,
    item: SyncItem,
  ): Promise<MlsGroup> {
    switch (item.type) {
      case 'commit': {
        if (BigInt(item.epoch) < group.epoch) return group; // already applied (e.g. our own)
        if (BigInt(item.epoch) > group.epoch) return this.rejoin(conversationId);
        let processed: Awaited<ReturnType<MlsGroup['processCommit']>>;
        try {
          const directory = toCryptoDirectory(await this.directory(conversationId));
          processed = await group.withDirectory(directory).processCommit(item.commit);
        } catch {
          // The commit may add a device registered after our cached directory was fetched.
          this.directoryCache.delete(conversationId);
          const directory = toCryptoDirectory(await this.directory(conversationId));
          try {
            processed = await group.withDirectory(directory).processCommit(item.commit);
          } catch {
            // Still unverifiable (e.g. offline across many membership changes): start over
            // from the current group state. Messages in between become unavailable here.
            return this.rejoin(conversationId);
          }
        }
        const { group: next, consumed, committer } = processed;
        await this.saveGroup(conversationId, next);
        wipeConsumed(consumed);
        await this.trackGroup(conversationId, group, next, {
          kind: 'commit',
          committer:
            committer.kind === 'member'
              ? { kind: 'member', ogcId: committer.ogcId }
              : { kind: 'external' },
        });
        if (!next.members().some((m) => m.deviceKeyId === this.requireIdentity().deviceKeyId)) {
          // This device was removed: forget the group; it can rejoin if still active.
          await this.store.delete(groupKey(conversationId));
        }
        return next;
      }
      case 'hidden':
        await this.removeMessage(conversationId, item.messageId);
        return group;
      case 'event': {
        await this.appendTimeline(conversationId, { ...item.event, version: item.version });
        const membership = ['MEMBER_JOINED', 'MEMBER_LEFT', 'MEMBER_REMOVED'];
        if (membership.includes(item.event.type)) this.directoryCache.delete(conversationId);
        if (item.event.type === 'MESSAGE_REMOVED') {
          const messageId = item.event.detail?.messageId;
          if (typeof messageId === 'string') {
            const removed = await this.findById(conversationId, messageId);
            if (removed) {
              await this.putMessage({ ...removed, state: 'deleted', payload: null, reactions: [] });
            }
          }
        }
        return group;
      }
      case 'message':
        return this.applyMessage(conversationId, group, item.message);
    }
  }

  /**
   * Drops this device's group state and joins again from the current GroupInfo
   * (external commit; the server only allows current members' eligible devices).
   */
  private async rejoin(conversationId: string): Promise<MlsGroup> {
    await this.store.delete(groupKey(conversationId));
    return this.ensureGroup(conversationId);
  }

  private async applyMessage(
    conversationId: string,
    group: MlsGroup,
    view: MessageView,
  ): Promise<MlsGroup> {
    const meta = await this.meta(conversationId);
    const stored = await this.findStored(conversationId, view.seq, view.clientMessageId);
    const base = fromServer(view, this.ogcId);
    if (view.deletedAt || !view.ciphertext) {
      await this.putMessage({ ...base, state: 'deleted', payload: null, reactions: [] });
      return group;
    }
    // Same content revision: only metadata (reactions, version) changed.
    if (stored?.revision === view.revision && stored.state !== 'pending') {
      await this.putMessage({ ...stored, version: view.version, reactions: view.reactions });
      return group;
    }
    // Our own message from this device: MLS senders cannot decrypt their own
    // ciphertext; the plaintext was stored locally when it was sent.
    if (view.sender.deviceKeyId === this.requireIdentity().deviceKeyId) {
      const pending = await this.pending(conversationId);
      const local = stored ?? pending.find((m) => m.clientMessageId === view.clientMessageId);
      await this.putMessage({
        ...base,
        state: local?.payload ? 'ok' : 'undecryptable',
        payload: local?.payload ?? null,
      });
      // Accepted by the server even if this device never saw the response: leave the outbox.
      await this.withoutPending(conversationId, view.clientMessageId);
      return group;
    }
    if (view.epoch < meta.joinEpoch) {
      await this.putMessage({ ...base, state: 'unavailable', payload: null });
      return group;
    }
    const aad =
      view.revision === 0
        ? messageAad(conversationId, view.clientMessageId)
        : editAad(conversationId, view.clientMessageId, view.revision);
    try {
      const result = await group.decrypt(view.ciphertext, aad);
      await this.saveGroup(conversationId, result.group);
      wipeConsumed(result.consumed);
      const payload = decodePayload(result.plaintext);
      // The sender is authenticated by MLS; it must match the server's routing metadata.
      const authentic =
        result.sender.ogcId === view.sender.ogcId &&
        result.sender.deviceKeyId === view.sender.deviceKeyId;
      await this.putMessage({
        ...base,
        state: payload && authentic ? 'ok' : 'undecryptable',
        payload: payload && authentic ? payload : null,
      });
      return result.group;
    } catch {
      await this.putMessage({ ...base, state: 'undecryptable', payload: null });
      return group;
    }
  }

  // -------------------------------------------------------------------------
  // Sending and editing
  // -------------------------------------------------------------------------

  /**
   * Queues and sends a message. The message is stored locally first (state
   * `pending`) so it survives going offline; `flushOutbox` retries it later
   * with the same client message ID, so the server never stores it twice.
   */
  async send(
    conversationId: string,
    draft: Draft & { forwardedFromId?: string },
  ): Promise<LocalMessage> {
    if (this.disposed) throw new EngineDisposedError();
    const payload: MessagePayload = messagePayloadSchema.parse({
      v: 1,
      ...(draft.text !== undefined && draft.text.trim() !== '' ? { text: draft.text } : {}),
      ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
    });
    const message: LocalMessage = {
      id: null,
      clientMessageId: crypto.randomUUID(),
      conversationId,
      seq: null,
      version: 0,
      senderOgcId: this.ogcId,
      senderDeviceKeyId: this.deviceKeyId ?? null,
      mine: true,
      state: 'pending',
      payload,
      replyToId: draft.replyToId ?? null,
      forwarded: draft.forwardedFromId !== undefined,
      revision: 0,
      editedAt: null,
      createdAt: new Date().toISOString(),
      reactions: [],
      attachmentIds: payload.attachments?.map((a) => a.id) ?? [],
    };
    await this.updatePending(conversationId, (messages) => [...messages, message]);
    this.emit({ type: 'messages', conversationId });
    return this.lock.run(conversationId, () =>
      this.deliver(message, draft.forwardedFromId, draft.mentions),
    );
  }

  private async deliver(
    message: LocalMessage,
    forwardedFromId?: string,
    mentions?: string[],
  ): Promise<LocalMessage> {
    const { conversationId } = message;
    if (!message.payload) throw new MessagingError('Nothing to send');
    try {
      await this.reconcileUnlocked(conversationId, false);
      for (let attempt = 0; ; attempt++) {
        const group = await this.ensureGroup(conversationId);
        const encrypted = await group.encrypt(
          encodePayload(message.payload),
          messageAad(conversationId, message.clientMessageId),
        );
        // The sending ratchet advanced: persist before the network call.
        await this.saveGroup(conversationId, encrypted.group);
        wipeConsumed(encrypted.consumed);
        try {
          const view = await this.transport.sendMessage(conversationId, {
            clientMessageId: message.clientMessageId,
            epoch: Number(group.epoch),
            ciphertext: encrypted.ciphertext,
            ...(message.replyToId ? { replyToId: message.replyToId } : {}),
            ...(forwardedFromId ? { forwardedFromId } : {}),
            ...(message.attachmentIds.length ? { attachmentIds: message.attachmentIds } : {}),
            ...(mentions?.length ? { mentions } : {}),
          });
          const sent: LocalMessage = {
            ...fromServer(view, this.ogcId),
            state: 'ok',
            payload: message.payload,
          };
          await this.putMessage(sent);
          await this.withoutPending(conversationId, message.clientMessageId);
          this.emit({ type: 'messages', conversationId });
          return sent;
        } catch (error) {
          if (errorCode(error) === 'STALE_EPOCH' && attempt < MAX_EPOCH_RETRIES) {
            await this.syncUnlocked(conversationId);
            continue;
          }
          if (errorCode(error) === 'MLS_MEMBERSHIP_STALE' && attempt < MAX_EPOCH_RETRIES) {
            // Someone left or was removed: remove their devices before encrypting anything new.
            await this.reconcileUnlocked(conversationId, true);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // Not sent, and not failed: it stays pending until another device joins, or until a
      // rate-limited resync can be retried (then the queue is sent after recovery).
      if (error instanceof ConversationWaitingError || isResyncPause(error)) return message;
      // Shut down mid-delivery: the message stays pending for the next engine on this device.
      if (error instanceof EngineDisposedError) throw error;
      if (!isRetryable(error)) {
        await this.updatePending(conversationId, (messages) =>
          messages.map((m) =>
            m.clientMessageId === message.clientMessageId ? { ...m, state: 'failed' as const } : m,
          ),
        );
        this.emit({ type: 'messages', conversationId });
      }
      throw error;
    }
  }

  /** Retries every pending message (after reconnecting). Failures stay queued. */
  async flushOutbox(): Promise<number> {
    if (this.disposed) return 0;
    let sent = 0;
    for (const key of await this.store.keys('pending:')) {
      const conversationId = key.slice('pending:'.length);
      // A conversation waiting for another device, or whose resync is rate-limited, keeps its
      // queue; the others are still sent.
      if (this.recovery.get(conversationId) === 'waiting') continue;
      if (this.resyncPausedUntil(conversationId) !== undefined) continue;
      for (const message of await this.pending(conversationId)) {
        if (message.state !== 'pending') continue;
        try {
          const result = await this.deliverIfPending(conversationId, message.clientMessageId);
          if (!result) continue;
          if (result.state !== 'ok') break;
          sent++;
        } catch (error) {
          // Throttled (429): this message stays pending; try the other conversations. Offline
          // or a server error: stop, the next reconnect or sync flushes again.
          if (error instanceof TransportError && error.status === 429) break;
          if (isRetryable(error)) return sent;
        }
      }
    }
    return sent;
  }

  /** Removes a message that failed permanently from the outbox. */
  async discardFailed(conversationId: string, clientMessageId: string): Promise<void> {
    await this.withoutPending(conversationId, clientMessageId);
    this.emit({ type: 'messages', conversationId });
  }

  async edit(conversationId: string, messageId: string, text: string): Promise<void> {
    await this.lock.run(conversationId, async () => {
      const message = await this.findById(conversationId, messageId);
      if (!message?.mine || message.state !== 'ok' || !message.payload || message.seq === null) {
        throw new MessagingError('This message cannot be edited');
      }
      const payload = messagePayloadSchema.parse({ ...message.payload, text });
      const revision = message.revision + 1;
      for (let attempt = 0; ; attempt++) {
        const group = await this.ensureGroup(conversationId);
        const encrypted = await group.encrypt(
          encodePayload(payload),
          editAad(conversationId, message.clientMessageId, revision),
        );
        await this.saveGroup(conversationId, encrypted.group);
        wipeConsumed(encrypted.consumed);
        try {
          const view = await this.transport.editMessage(messageId, {
            epoch: Number(group.epoch),
            ciphertext: encrypted.ciphertext,
          });
          await this.putMessage({ ...fromServer(view, this.ogcId), state: 'ok', payload });
          this.emit({ type: 'messages', conversationId });
          return;
        } catch (error) {
          if (errorCode(error) === 'STALE_EPOCH' && attempt < MAX_EPOCH_RETRIES) {
            await this.syncUnlocked(conversationId);
            continue;
          }
          if (errorCode(error) === 'MLS_MEMBERSHIP_STALE' && attempt < MAX_EPOCH_RETRIES) {
            await this.reconcileUnlocked(conversationId, true);
            continue;
          }
          throw error;
        }
      }
    });
  }

  /**
   * Deletes for everyone: the server and every device erase the content.
   * Senders within the time window; in groups also moderators (others' messages).
   */
  async deleteForEveryone(conversationId: string, messageId: string): Promise<void> {
    await this.transport.deleteMessage(messageId, 'everyone');
    await this.lock.run(conversationId, async () => {
      const message = await this.findById(conversationId, messageId);
      if (message)
        await this.putMessage({ ...message, state: 'deleted', payload: null, reactions: [] });
    });
    this.emit({ type: 'messages', conversationId });
  }

  /** Deletes on all of this account's devices only. */
  async deleteForMe(conversationId: string, messageId: string): Promise<void> {
    await this.transport.deleteMessage(messageId, 'self');
    await this.lock.run(conversationId, () => this.removeMessage(conversationId, messageId));
    this.emit({ type: 'messages', conversationId });
  }

  async react(
    conversationId: string,
    messageId: string,
    reaction: ReactionType,
    add: boolean,
  ): Promise<void> {
    await this.transport.react(messageId, reaction, add);
    await this.scheduleSync(conversationId);
  }

  /** Marks everything up to the newest message as read on the server. */
  async markRead(conversationId: string): Promise<void> {
    const messages = await this.messages(conversationId, BUCKET);
    const newest = messages.reduce((max, m) => Math.max(max, m.seq ?? 0), 0);
    const view = this.conversationCache.get(conversationId);
    if (newest === 0 || (view && view.myLastReadSeq >= newest && view.unreadCount === 0)) return;
    await this.transport.markRead(conversationId, newest);
    if (view) {
      this.conversationCache.set(conversationId, {
        ...view,
        myLastReadSeq: newest,
        unreadCount: 0,
      });
      this.emit({ type: 'conversations' });
    }
  }

  /**
   * Forwards a readable message into another conversation. The content is
   * re-encrypted for the target conversation on this device (attachments are
   * re-uploaded with fresh keys); the server only learns that it was forwarded.
   */
  async forward(
    sourceConversationId: string,
    messageId: string,
    targetConversationId: string,
  ): Promise<LocalMessage> {
    const source = await this.findById(sourceConversationId, messageId);
    if (source?.state !== 'ok' || !source.payload || !source.id) {
      throw new MessagingError('This message cannot be forwarded');
    }
    const attachments: AttachmentDescriptor[] = [];
    for (const descriptor of source.payload.attachments ?? []) {
      const bytes = await this.openAttachment(descriptor);
      attachments.push(
        await this.uploadAttachment(targetConversationId, {
          kind: descriptor.kind,
          name: descriptor.name,
          mime: descriptor.mime,
          bytes,
          ...(descriptor.width ? { width: descriptor.width } : {}),
          ...(descriptor.height ? { height: descriptor.height } : {}),
          ...(descriptor.durationMs ? { durationMs: descriptor.durationMs } : {}),
          ...(descriptor.waveform ? { waveform: descriptor.waveform } : {}),
        }),
      );
    }
    return this.send(targetConversationId, {
      ...(source.payload.text ? { text: source.payload.text } : {}),
      ...(attachments.length ? { attachments } : {}),
      forwardedFromId: source.id,
    });
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  /** Encrypts a file on this device and uploads only the ciphertext. */
  async uploadAttachment(
    conversationId: string,
    file: OutgoingAttachment,
  ): Promise<AttachmentDescriptor> {
    if (file.bytes.length === 0 || file.bytes.length > ATTACHMENT_MAX_BYTES[file.kind]) {
      throw new MessagingError('This file is too large');
    }
    const { ciphertext, secret } = encryptAttachment(file.bytes);
    const uploaded = await this.transport.uploadAttachment(conversationId, file.kind, ciphertext);
    return {
      id: uploaded.id,
      kind: file.kind,
      name: file.name,
      mime: file.mime,
      size: file.bytes.length,
      key: secret.key,
      nonce: secret.nonce,
      digest: secret.digest,
      ...(file.width ? { width: file.width } : {}),
      ...(file.height ? { height: file.height } : {}),
      ...(file.durationMs ? { durationMs: file.durationMs } : {}),
      ...(file.waveform ? { waveform: file.waveform } : {}),
    };
  }

  /** Downloads and decrypts an attachment, verifying its digest and size. */
  async openAttachment(descriptor: AttachmentDescriptor): Promise<Uint8Array> {
    const ciphertext = await this.transport.downloadAttachment(descriptor.id);
    const secret: AttachmentSecret = {
      key: descriptor.key,
      nonce: descriptor.nonce,
      digest: descriptor.digest,
    };
    const bytes = decryptAttachment(ciphertext, secret);
    if (bytes.length !== descriptor.size) throw new MessagingError('Attachment size mismatch');
    return bytes;
  }

  // -------------------------------------------------------------------------
  // Realtime, search, verification
  // -------------------------------------------------------------------------

  /** Feeds a realtime event into the engine. Events only trigger syncs; sync is the source of truth. */
  handleRealtime<E extends keyof ServerToClientEvents>(
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ): void {
    if (this.disposed) return;
    const run = (task: Promise<unknown>, conversationId?: string): void => {
      task.catch((error: unknown) => {
        this.emit({ type: 'error', ...(conversationId ? { conversationId } : {}), error });
      });
    };
    switch (event) {
      case 'conversation.created': {
        const { conversation } = payload as Parameters<
          ServerToClientEvents['conversation.created']
        >[0];
        this.conversationCache.set(conversation.id, conversation);
        run(this.persistConversations());
        this.emit({ type: 'conversations' });
        return;
      }
      case 'message.created':
      case 'message.updated':
      case 'message.deleted': {
        const { message } = payload as Parameters<ServerToClientEvents['message.created']>[0];
        run(this.scheduleSync(message.conversationId), message.conversationId);
        run(this.refreshConversation(message.conversationId), message.conversationId);
        return;
      }
      case 'message.reaction':
      case 'message.hidden':
      case 'mls.commit':
      case 'conversation.updated': {
        const { conversationId } = payload as { conversationId: string };
        if (event === 'mls.commit') this.armRecovery(conversationId);
        run(this.scheduleSync(conversationId), conversationId);
        return;
      }
      case 'message.read':
      case 'message.delivered': {
        const { conversationId } = payload as { conversationId: string };
        run(this.refreshConversation(conversationId), conversationId);
        return;
      }
      case 'mls.welcome':
        run(this.processWelcomes());
        return;
      case 'devices.changed': {
        const { conversationId } = payload as { conversationId: string };
        this.directoryCache.delete(conversationId);
        this.armRecovery(conversationId);
        run(this.reconcile(conversationId), conversationId);
        return;
      }
      case 'group.created': {
        const { conversation } = payload as Parameters<ServerToClientEvents['group.created']>[0];
        this.conversationCache.set(conversation.id, conversation);
        run(this.persistConversations());
        this.emit({ type: 'conversations' });
        return;
      }
      case 'group.updated':
      case 'group.role_changed':
      case 'group.member_joined':
      case 'group.member_left': {
        const { conversationId } = payload as { conversationId: string };
        this.directoryCache.delete(conversationId);
        if (event === 'group.member_joined') this.armRecovery(conversationId);
        run(this.scheduleSync(conversationId), conversationId);
        return;
      }
      case 'group.member_removed': {
        const { conversationId, ogcId } = payload as Parameters<
          ServerToClientEvents['group.member_removed']
        >[0];
        this.directoryCache.delete(conversationId);
        if (ogcId === this.ogcId) {
          run(
            this.lock.run(conversationId, () => this.forgetConversation(conversationId)),
            conversationId,
          );
        } else {
          run(this.scheduleSync(conversationId), conversationId);
        }
        return;
      }
      case 'group.deleted': {
        const { conversationId } = payload as { conversationId: string };
        run(
          this.lock.run(conversationId, () => this.forgetConversation(conversationId)),
          conversationId,
        );
        return;
      }
      case 'group.invitation_created': {
        const { invitation } = payload as Parameters<
          ServerToClientEvents['group.invitation_created']
        >[0];
        this.emit({ type: 'invitations', invitation });
        return;
      }
      case 'group.invitation_revoked':
        this.emit({ type: 'invitations' });
        return;
      case 'community.notification': {
        const { notification } = payload as Parameters<
          ServerToClientEvents['community.notification']
        >[0];
        this.emit({ type: 'notification', notification });
        return;
      }
      case 'channel.created':
      case 'channel.updated':
      case 'channel.member_joined':
      case 'channel.member_left':
      case 'channel.post_created':
      case 'channel.post_updated':
      case 'channel.post_deleted':
      case 'channel.post_pinned':
      case 'channel.announcement_created':
      case 'channel.access_revoked': {
        const data = payload as { channelId?: string; channel?: { id: string }; postId?: string };
        const channelId = data.channelId ?? data.channel?.id;
        if (channelId) {
          this.emit({
            type: 'channel',
            channelId,
            event,
            ...(data.postId ? { postId: data.postId } : {}),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Searches this device's decrypted messages (ADR-030). There is no server
   * search: the server cannot read messages. Results are newest first.
   */
  async search(query: string, limit = 50): Promise<LocalMessage[]> {
    const needle = searchable(query.trim());
    if (needle.length < 2) return [];
    const results: LocalMessage[] = [];
    for (const key of (await this.store.keys('msgs:')).sort().reverse()) {
      for (const message of (await this.readBucket(key)).reverse()) {
        const haystack = [
          message.payload?.text ?? '',
          ...(message.payload?.attachments ?? []).map((a) => a.name),
        ]
          .map(searchable)
          .join('\n');
        if (message.state === 'ok' && haystack.includes(needle)) results.push(message);
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  /**
   * The safety number between this account and another participant (in a
   * DIRECT conversation, the peer), from the device directory both can compare.
   */
  async safetyNumber(conversationId: string, peerOgcId?: string): Promise<string[]> {
    const directory = await this.directory(conversationId);
    const byAccount = new Map<string, Uint8Array[]>();
    for (const device of directory) {
      byAccount.set(device.ogcId, [
        ...(byAccount.get(device.ogcId) ?? []),
        fromBase64(device.signaturePublicKey),
      ]);
    }
    const parties = [...byAccount.entries()]
      .filter(([ogcId]) => peerOgcId === undefined || ogcId === peerOgcId || ogcId === this.ogcId)
      .map(([ogcId, deviceKeys]) => ({ ogcId, deviceKeys }));
    if (parties.length > 2) throw new MessagingError('Choose a member to compare with');
    const [a, b] = parties;
    if (!a || !b) throw new MessagingError('Both people need an encryption-ready device');
    return safetyNumber(a, b);
  }

  /** The other person of a direct conversation and their current device signature keys. */
  private async peerKeys(
    conversationId: string,
  ): Promise<{ peer: string; keys: string[] } | undefined> {
    const conversation = this.conversationCache.get(conversationId);
    const peer = conversation?.peer?.ogcId;
    if (!peer) return undefined;
    // Fresh from the server, not the directory cache: a key change must show at once.
    this.directoryCache.delete(conversationId);
    const keys = (await this.directory(conversationId))
      .filter((device) => device.ogcId === peer)
      .map((device) => device.signaturePublicKey);
    return { peer, keys };
  }

  /**
   * Whether the other person's devices changed since this device last accepted them (direct
   * conversations). Trust on first use: the first keys seen are remembered silently.
   */
  async peerKeyStatus(conversationId: string): Promise<PeerKeyStatus> {
    const found = await this.peerKeys(conversationId);
    if (!found || found.keys.length === 0) return { state: 'unverified', added: 0 };
    const stored = await this.store.getJson<PeerKeyRecord>(peerKeysKey(found.peer));
    const { record, status } = reconcilePeerKeys(stored, found.keys);
    await this.store.setJson(peerKeysKey(found.peer), record);
    return status;
  }

  /** Accepts the other person's current devices without verifying (dismisses the warning). */
  async acknowledgePeerKeys(conversationId: string): Promise<void> {
    const found = await this.peerKeys(conversationId);
    if (!found) return;
    await this.store.setJson(peerKeysKey(found.peer), acknowledgePeerKeys(found.keys));
  }

  /**
   * Marks the other person as verified after comparing the safety number in person. The
   * number is recomputed here from the current keys (never taken from the caller).
   */
  async markPeerVerified(conversationId: string): Promise<void> {
    const found = await this.peerKeys(conversationId);
    if (!found || found.keys.length === 0)
      throw new MessagingError('Both people need an encryption-ready device');
    const number = await this.safetyNumber(conversationId, found.peer);
    await this.store.setJson(peerKeysKey(found.peer), verifyPeerKeys(found.keys, number));
  }

  /** Erases all local messaging data (sign-out). Server-side, logout revokes the device key. */
  async wipe(): Promise<void> {
    for (const { timer } of this.resyncPaused.values()) this.timers.clearTimeout(timer);
    this.resyncPaused.clear();
    this.recovery.clear();
    await this.store.clear();
    this.identity = undefined;
    this.conversationCache.clear();
  }
}

export { TransportError };
