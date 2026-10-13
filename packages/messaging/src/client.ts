import {
  type AttachmentSecret,
  type DirectoryDevice as CryptoDirectoryDevice,
  type GeneratedKeyPackage,
  type LocalDevice,
  MlsGroup,
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
  override readonly name = 'MessagingError';
}

const metaKey = (c: string): string => `meta:${c}`;
const groupKey = (c: string): string => `group:${c}`;
const bucketKey = (c: string, seq: number): string =>
  `msgs:${c}:${String(Math.floor(seq / BUCKET)).padStart(12, '0')}`;
const pendingKey = (c: string): string => `pending:${c}`;
const kpKey = (ref: string): string => `kp:${ref}`;
const timelineKey = (c: string): string => `timeline:${c}`;

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
  private readonly listeners = new Set<(event: MessagingEvent) => void>();
  private readonly scheduledSyncs = new Map<string, Promise<void>>();
  private identity: LocalDevice | undefined;
  private conversationCache = new Map<string, ConversationView>();
  private readonly directoryCache = new Map<string, { at: number; devices: DirectoryDevice[] }>();

  constructor(
    private readonly transport: MessagingTransport,
    private readonly store: SealedStore,
    readonly ogcId: string,
  ) {}

  get deviceKeyId(): string | undefined {
    return this.identity?.deviceKeyId;
  }

  subscribe(listener: (event: MessagingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MessagingEvent): void {
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

  private async setPending(conversationId: string, messages: LocalMessage[]): Promise<void> {
    if (messages.length === 0) await this.store.delete(pendingKey(conversationId));
    else await this.store.setJson(pendingKey(conversationId), messages);
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
          await this.syncConversation(conversation.id);
          synced++;
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
      if (existing) return existing;
      const server = await this.transport.mlsGroup(conversationId);
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
        // …otherwise join by ourselves from the published GroupInfo (external commit).
        const joined = await MlsGroup.joinExternal(identity, server.groupInfo, directory);
        await this.transport.submitCommit(conversationId, {
          epoch: server.epoch,
          commit: joined.commit,
          groupInfo: joined.groupInfo,
        });
        await this.saveGroup(conversationId, joined.group);
        await this.saveMeta(conversationId, {
          ...(await this.meta(conversationId)),
          joinEpoch: Number(joined.group.epoch),
        });
        return joined.group;
      } catch (error) {
        if (errorCode(error) !== 'STALE_EPOCH') throw error;
      }
    }
    throw new MessagingError('Could not establish the secure session; try again');
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
    await this.lock.run(conversationId, () => this.reconcileUnlocked(conversationId, true));
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
    await this.store.delete(pendingKey(conversationId));
    await this.store.delete(timelineKey(conversationId));
    this.directoryCache.delete(conversationId);
    if (this.conversationCache.delete(conversationId)) await this.persistConversations();
    this.emit({ type: 'removed', conversationId });
    this.emit({ type: 'conversations' });
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
        const { group: next, consumed } = processed;
        await this.saveGroup(conversationId, next);
        wipeConsumed(consumed);
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
      await this.setPending(
        conversationId,
        pending.filter((m) => m.clientMessageId !== view.clientMessageId),
      );
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
    await this.setPending(conversationId, [...(await this.pending(conversationId)), message]);
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
          await this.setPending(
            conversationId,
            (await this.pending(conversationId)).filter(
              (m) => m.clientMessageId !== message.clientMessageId,
            ),
          );
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
      if (!isRetryable(error)) {
        await this.setPending(
          conversationId,
          (await this.pending(conversationId)).map((m) =>
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
    let sent = 0;
    for (const key of await this.store.keys('pending:')) {
      const conversationId = key.slice('pending:'.length);
      for (const message of await this.pending(conversationId)) {
        if (message.state !== 'pending') continue;
        try {
          await this.lock.run(conversationId, () => this.deliver(message));
          sent++;
        } catch (error) {
          if (isRetryable(error)) return sent;
        }
      }
    }
    return sent;
  }

  /** Removes a message that failed permanently from the outbox. */
  async discardFailed(conversationId: string, clientMessageId: string): Promise<void> {
    await this.setPending(
      conversationId,
      (await this.pending(conversationId)).filter((m) => m.clientMessageId !== clientMessageId),
    );
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

  /** Erases all local messaging data (sign-out). Server-side, logout revokes the device key. */
  async wipe(): Promise<void> {
    await this.store.clear();
    this.identity = undefined;
    this.conversationCache.clear();
  }
}

export { TransportError };
