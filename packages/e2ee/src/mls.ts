import {
  type ClientConfig,
  type ClientState,
  type Credential,
  type GroupInfo,
  type IncomingMessageCallback,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
  type Proposal,
  createApplicationMessage,
  createCommit,
  createGroup,
  createGroupInfoWithExternalPubAndRatchetTree,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  joinGroup,
  joinGroupExternal,
  makePskIndex,
  processPublicMessage,
  zeroOutUint8Array,
} from 'ts-mls';
import { ratchetTreeFromExtension } from 'ts-mls/groupInfo.js';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { unprotectPrivateMessage } from 'ts-mls/messageProtection.js';
import { equalBytes, fromBase64, toBase64, toHex, utf8 } from './bytes.js';
import { type DeviceCredential, deviceCredential, parseDeviceCredential } from './credential.js';
import { OGC_CIPHERSUITE, ogcSuite } from './provider.js';

/** A device's long-term MLS signature key pair (Ed25519). Never leaves the device. */
export interface SigningKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** The local device as an MLS client. */
export interface LocalDevice extends DeviceCredential {
  signing: SigningKeyPair;
}

/** A device published in the server's directory, used to authenticate group members. */
export interface DirectoryDevice extends DeviceCredential {
  signaturePublicKey: Uint8Array;
}

/** A group member as seen in the local ratchet tree. */
export interface GroupMember extends DeviceCredential {
  leafIndex: number;
  signaturePublicKey: Uint8Array;
}

/** A key package ready for upload, with the private half that stays on the device. */
export interface GeneratedKeyPackage {
  /** Hex KeyPackageRef (RFC 9420 §5.2), used to match incoming Welcome messages. */
  ref: string;
  /** TLS-encoded MLSMessage(KeyPackage), base64 — safe to publish. */
  publicKey: string;
  /** Serialized private keys — must be stored only in the device's sealed store. */
  privateKey: string;
}

export class MlsSecurityError extends Error {
  override readonly name = 'MlsSecurityError';
}

/**
 * Not a security failure: this device's leaf — verified as its own (identity and signature key) —
 * is the only non-blank leaf of the published tree, and ts-mls 1.6.4 cannot remove a tree's last
 * leaf, so it cannot resync now. It can once any other device joins the group.
 */
export class MlsSoleMemberError extends Error {
  override readonly name = 'MlsSoleMemberError';
}

/** Key packages expire so a stale, possibly compromised, package cannot be used forever. */
export const KEY_PACKAGE_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

/** Binds application ciphertext to its conversation and client-generated message ID. */
export function messageAad(conversationId: string, clientMessageId: string): Uint8Array {
  return utf8(`ogc-msg/v1/${conversationId}/${clientMessageId}`);
}

/** Binds an edit's ciphertext to the edited message and its revision number. */
export function editAad(
  conversationId: string,
  clientMessageId: string,
  revision: number,
): Uint8Array {
  return utf8(`ogc-edit/v1/${conversationId}/${clientMessageId}/${revision}`);
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const cs = await ogcSuite();
  const { publicKey, signKey } = await cs.signature.keygen();
  return { publicKey, privateKey: signKey };
}

function clientConfig(directory: ReadonlyMap<string, DirectoryDevice>): ClientConfig {
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    // Every credential in a group must be a known OGC device with the published signature key.
    authService: {
      validateCredential(credential: Credential, signaturePublicKey: Uint8Array) {
        return Promise.resolve(inDirectory(directory, credential, signaturePublicKey));
      },
    },
  };
}

/** True when the credential is a known OGC device using its published signature key. */
function inDirectory(
  directory: ReadonlyMap<string, DirectoryDevice>,
  credential: Credential,
  signaturePublicKey: Uint8Array,
): boolean {
  const parsed = parseDeviceCredential(credential);
  if (!parsed) return false;
  const known = directory.get(parsed.deviceKeyId);
  if (!known) return false;
  return known.ogcId === parsed.ogcId && equalBytes(known.signaturePublicKey, signaturePublicKey);
}

function directoryMap(devices: readonly DirectoryDevice[]): ReadonlyMap<string, DirectoryDevice> {
  return new Map(devices.map((d) => [d.deviceKeyId, d]));
}

function lifetime(): { notBefore: bigint; notAfter: bigint } {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return { notBefore: now - 3600n, notAfter: now + BigInt(KEY_PACKAGE_LIFETIME_SECONDS) };
}

function decodeMessage(bytes: Uint8Array): MLSMessage {
  const decoded = decodeMlsMessage(bytes, 0);
  if (decoded?.[1] !== bytes.length) throw new MlsSecurityError('Malformed MLS message');
  return decoded[0];
}

export function decodeMessageBase64(text: string): MLSMessage {
  return decodeMessage(fromBase64(text));
}

function encodeMessage(message: MLSMessage): string {
  return toBase64(encodeMlsMessage(message));
}

interface StoredPrivateKeyPackage {
  keyPackage: string;
  init: string;
  hpke: string;
  signature: string;
}

function serializePrivate(keyPackage: KeyPackage, priv: PrivateKeyPackage): string {
  const stored: StoredPrivateKeyPackage = {
    keyPackage: encodeMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage }),
    init: toBase64(priv.initPrivateKey),
    hpke: toBase64(priv.hpkePrivateKey),
    signature: toBase64(priv.signaturePrivateKey),
  };
  return JSON.stringify(stored);
}

function parsePrivate(text: string): { keyPackage: KeyPackage; priv: PrivateKeyPackage } {
  const stored = JSON.parse(text) as StoredPrivateKeyPackage;
  const message = decodeMessageBase64(stored.keyPackage);
  if (message.wireformat !== 'mls_key_package') throw new MlsSecurityError('Not a key package');
  return {
    keyPackage: message.keyPackage,
    priv: {
      initPrivateKey: fromBase64(stored.init),
      hpkePrivateKey: fromBase64(stored.hpke),
      signaturePrivateKey: fromBase64(stored.signature),
    },
  };
}

/** Creates one-time key packages that let other devices add this device to conversations. */
export async function generateKeyPackages(
  device: LocalDevice,
  count: number,
): Promise<GeneratedKeyPackage[]> {
  const cs = await ogcSuite();
  const credential = deviceCredential(device);
  const result: GeneratedKeyPackage[] = [];
  for (let i = 0; i < count; i++) {
    const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
      credential,
      defaultCapabilities(),
      lifetime(),
      [],
      { signKey: device.signing.privateKey, publicKey: device.signing.publicKey },
      cs,
    );
    result.push({
      ref: toHex(await makeKeyPackageRef(publicPackage, cs.hash)),
      publicKey: encodeMessage({
        version: 'mls10',
        wireformat: 'mls_key_package',
        keyPackage: publicPackage,
      }),
      privateKey: serializePrivate(publicPackage, privatePackage),
    });
  }
  return result;
}

function memberList(state: ClientState): GroupMember[] {
  const members: GroupMember[] = [];
  state.ratchetTree.forEach((node, nodeIndex) => {
    if (node?.nodeType !== 'leaf') return;
    const parsed = parseDeviceCredential(node.leaf.credential);
    if (!parsed) return;
    members.push({
      ...parsed,
      leafIndex: nodeIndex / 2,
      signaturePublicKey: node.leaf.signaturePublicKey,
    });
  });
  return members;
}

/**
 * The leaf index of this device in a GroupInfo's ratchet tree, if it is there. The device is
 * there only if exactly one leaf carries its credential and that leaf uses its own signature
 * key. Anything ambiguous (its ID with another key, its key under another identity, more than
 * one leaf) is refused: building a resync commit from it could remove the wrong leaf.
 */
function ownLeafInGroupInfo(info: GroupInfo, device: LocalDevice): number | undefined {
  const tree = ratchetTreeFromExtension(info);
  if (!tree) throw new MlsSecurityError('GroupInfo must include the ratchet tree');
  const byIdentity: number[] = [];
  const byKey: number[] = [];
  let leaves = 0;
  tree.forEach((node, nodeIndex) => {
    if (node?.nodeType !== 'leaf') return;
    leaves++;
    const credential = parseDeviceCredential(node.leaf.credential);
    const leafIndex = nodeIndex / 2;
    if (credential?.deviceKeyId === device.deviceKeyId) byIdentity.push(leafIndex);
    if (equalBytes(node.leaf.signaturePublicKey, device.signing.publicKey)) byKey.push(leafIndex);
  });
  if (byIdentity.length === 0 && byKey.length === 0) return undefined;
  const [leaf] = byIdentity;
  const node = leaf === undefined ? undefined : tree[leaf * 2];
  const credential =
    node?.nodeType === 'leaf' ? parseDeviceCredential(node.leaf.credential) : undefined;
  if (
    byIdentity.length !== 1 ||
    byKey.length !== 1 ||
    byKey[0] !== leaf ||
    credential?.ogcId !== device.ogcId
  ) {
    throw new MlsSecurityError(
      'This device appears in the group with a different identity or key; it cannot rejoin safely',
    );
  }
  // ts-mls cannot remove a tree's only leaf (it fails internally): a sole member cannot resync.
  // Checked last, so only a leaf verified as this device's own reaches it.
  if (leaves === 1) {
    throw new MlsSoleMemberError(
      'This device is the only member of the group, so it cannot rejoin it until another device joins',
    );
  }
  return leaf;
}

/** Only membership changes are allowed in OGC commits: no PSKs, re-inits or extension changes. */
const membershipOnly: IncomingMessageCallback = (incoming) => {
  const proposals =
    incoming.kind === 'commit'
      ? incoming.proposals.map((p) => p.proposal)
      : [incoming.proposal.proposal];
  const allowed = proposals.every(
    (p) =>
      typeof p.proposalType === 'string' &&
      ['add', 'remove', 'update', 'external_init'].includes(p.proposalType),
  );
  return allowed ? 'accept' : 'reject';
};

/** Who made a processed commit: an existing member device, or a device joining by itself. */
export type CommitSender = ({ kind: 'member' } & DeviceCredential) | { kind: 'external' };

export interface CommitResult {
  group: MlsGroup;
  /** MLSMessage(PublicMessage) carrying the commit, base64. */
  commit: string;
  /** MLSMessage(Welcome) for added devices, base64, if any were added. */
  welcome: string | undefined;
  /** MLSMessage(GroupInfo) for the new epoch (enables external joins), base64. */
  groupInfo: string;
  /** Device key IDs added by this commit. */
  added: string[];
  /** Secrets used by the previous epoch; wipe with `wipeConsumed` once the commit is accepted. */
  consumed: Uint8Array[];
}

/**
 * One device's view of one conversation's MLS group. Immutable: every
 * operation returns a new `MlsGroup`, so a rejected commit can be discarded
 * without corrupting the stored state.
 */
export class MlsGroup {
  private constructor(
    private readonly state: ClientState,
    private readonly directory: ReadonlyMap<string, DirectoryDevice>,
  ) {}

  get epoch(): bigint {
    return this.state.groupContext.epoch;
  }

  get groupId(): string {
    return new TextDecoder().decode(this.state.groupContext.groupId);
  }

  get ownLeafIndex(): number {
    return this.state.privatePath.leafIndex;
  }

  members(): GroupMember[] {
    return memberList(this.state);
  }

  /** Serialized state (contains private keys): store only in the device's sealed store. */
  serialize(): Uint8Array {
    return encodeGroupState(this.state);
  }

  static async restore(
    bytes: Uint8Array,
    directory: readonly DirectoryDevice[],
  ): Promise<MlsGroup> {
    await ogcSuite();
    const decoded = decodeGroupState(bytes, 0);
    if (!decoded) throw new MlsSecurityError('Corrupt group state');
    const map = directoryMap(directory);
    return new MlsGroup({ ...decoded[0], clientConfig: clientConfig(map) }, map);
  }

  /** Returns a copy that authenticates members against an updated device directory. */
  withDirectory(directory: readonly DirectoryDevice[]): MlsGroup {
    const map = directoryMap(directory);
    return new MlsGroup({ ...this.state, clientConfig: clientConfig(map) }, map);
  }

  /** Creates a new group (epoch 0) containing only the local device. */
  static async create(
    device: LocalDevice,
    conversationId: string,
    directory: readonly DirectoryDevice[],
  ): Promise<MlsGroup> {
    const cs = await ogcSuite();
    const map = directoryMap(directory);
    const [own] = await generateKeyPackages(device, 1);
    if (!own) throw new Error('Key package generation failed');
    const { keyPackage, priv } = parsePrivate(own.privateKey);
    const state = await createGroup(
      utf8(conversationId),
      keyPackage,
      priv,
      [],
      cs,
      clientConfig(map),
    );
    return new MlsGroup(state, map);
  }

  /** Joins a group from a Welcome addressed to one of this device's key packages. */
  static async joinFromWelcome(
    welcome: string,
    storedKeyPackage: GeneratedKeyPackage,
    directory: readonly DirectoryDevice[],
  ): Promise<MlsGroup> {
    const cs = await ogcSuite();
    const message = decodeMessageBase64(welcome);
    if (message.wireformat !== 'mls_welcome') throw new MlsSecurityError('Not a Welcome message');
    const map = directoryMap(directory);
    const { keyPackage, priv } = parsePrivate(storedKeyPackage.privateKey);
    const state = await joinGroup(
      message.welcome,
      keyPackage,
      priv,
      emptyPskIndex,
      cs,
      undefined,
      undefined,
      clientConfig(map),
    );
    return new MlsGroup(state, map);
  }

  /**
   * Joins an existing group without being added by a member (RFC 9420 §12.4.3.2),
   * using the GroupInfo the members publish with every commit. Used by a new
   * device of a participant when no other member device is online.
   *
   * If the published tree still holds this device (it lost its group state), the join is a
   * resync: the commit removes exactly that leaf and adds a fresh one, so the device is in the
   * group once, with new path secrets. Whether to resync is decided from the GroupInfo's tree,
   * which ts-mls verifies (tree hash and signature of a directory-checked member) before
   * building the commit — never from local state or the server's member list.
   * `requireResync` refuses to join unless this is a resync.
   */
  static async joinExternal(
    device: LocalDevice,
    groupInfo: string,
    directory: readonly DirectoryDevice[],
    options: { requireResync?: boolean } = {},
  ): Promise<{ group: MlsGroup; commit: string; groupInfo: string; resynced: boolean }> {
    const cs = await ogcSuite();
    const message = decodeMessageBase64(groupInfo);
    if (message.wireformat !== 'mls_group_info') throw new MlsSecurityError('Not a GroupInfo');
    const formerLeaf = ownLeafInGroupInfo(message.groupInfo, device);
    if (options.requireResync && formerLeaf === undefined) {
      throw new MlsSecurityError('This device is not in the group, so it cannot resync');
    }
    const map = directoryMap(directory);
    const [own] = await generateKeyPackages(device, 1);
    if (!own) throw new Error('Key package generation failed');
    const { keyPackage, priv } = parsePrivate(own.privateKey);
    // ts-mls must only be asked to resync when the leaf exists: given a missing leaf it does
    // not fail (it computes an invalid leaf index and never returns).
    const resync = formerLeaf !== undefined;
    const { newState, publicMessage } = await joinGroupExternal(
      message.groupInfo,
      keyPackage,
      priv,
      resync,
      cs,
      undefined,
      clientConfig(map),
    );
    if (publicMessage.content.contentType !== 'commit') throw new MlsSecurityError('Not a commit');
    const removed = publicMessage.content.commit.proposals.flatMap((p) =>
      p.proposalOrRefType === 'proposal' && p.proposal.proposalType === 'remove'
        ? [p.proposal.remove.removed]
        : [],
    );
    if (removed.length !== (resync ? 1 : 0) || (resync && removed[0] !== formerLeaf)) {
      throw new MlsSecurityError('The rejoin would change other members; refusing it');
    }
    const group = new MlsGroup(newState, map);
    return {
      group,
      commit: encodeMessage({ version: 'mls10', wireformat: 'mls_public_message', publicMessage }),
      groupInfo: await group.groupInfo(),
      resynced: resync,
    };
  }

  /** GroupInfo for the current epoch, including the ratchet tree and external public key. */
  async groupInfo(): Promise<string> {
    const cs = await ogcSuite();
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(this.state, [], cs);
    return encodeMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo });
  }

  /** Adds and/or removes devices in one commit, advancing the epoch. */
  async commit(change: { add?: string[]; removeDeviceKeyIds?: string[] }): Promise<CommitResult> {
    const cs = await ogcSuite();
    const proposals: Proposal[] = [];
    const added: string[] = [];
    for (const encoded of change.add ?? []) {
      const message = decodeMessageBase64(encoded);
      if (message.wireformat !== 'mls_key_package') throw new MlsSecurityError('Not a key package');
      const { credential: leafCredential, signaturePublicKey } = message.keyPackage.leafNode;
      const credential = parseDeviceCredential(leafCredential);
      if (!credential || !inDirectory(this.directory, leafCredential, signaturePublicKey)) {
        throw new MlsSecurityError('Key package does not match the device directory');
      }
      proposals.push({ proposalType: 'add', add: { keyPackage: message.keyPackage } });
      added.push(credential.deviceKeyId);
    }
    const removeIds = new Set(change.removeDeviceKeyIds ?? []);
    for (const member of this.members()) {
      if (removeIds.has(member.deviceKeyId) && member.leafIndex !== this.ownLeafIndex) {
        proposals.push({ proposalType: 'remove', remove: { removed: member.leafIndex } });
      }
    }
    const result = await createCommit(
      { state: this.state, cipherSuite: cs, pskIndex: makePskIndex(this.state, {}) },
      { extraProposals: proposals, wireAsPublicMessage: true, ratchetTreeExtension: true },
    );
    const group = new MlsGroup(result.newState, this.directory);
    return {
      group,
      commit: encodeMessage(result.commit),
      welcome: result.welcome
        ? encodeMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome })
        : undefined,
      groupInfo: await group.groupInfo(),
      added,
      consumed: result.consumed,
    };
  }

  /**
   * Applies a commit from another member (or an external join), advancing the epoch.
   * `committer` is taken from the verified commit: a member device of the previous epoch's
   * tree, or `external` when a device added itself from the published GroupInfo.
   */
  async processCommit(
    commit: string,
  ): Promise<{ group: MlsGroup; consumed: Uint8Array[]; committer: CommitSender }> {
    const cs = await ogcSuite();
    const message = decodeMessageBase64(commit);
    if (message.wireformat !== 'mls_public_message') {
      throw new MlsSecurityError('Commits must be public messages');
    }
    if (message.publicMessage.content.contentType !== 'commit') {
      throw new MlsSecurityError('Not a commit');
    }
    const { newState, actionTaken, consumed } = await processPublicMessage(
      this.state,
      message.publicMessage,
      makePskIndex(this.state, {}),
      cs,
      membershipOnly,
    );
    if (actionTaken !== 'accept') throw new MlsSecurityError('Commit rejected');
    const sender = message.publicMessage.content.sender;
    let committer: CommitSender = { kind: 'external' };
    if (sender.senderType === 'member') {
      const leaf = this.state.ratchetTree[sender.leafIndex * 2];
      const credential =
        leaf?.nodeType === 'leaf' ? parseDeviceCredential(leaf.leaf.credential) : undefined;
      if (!credential) throw new MlsSecurityError('Unknown sender');
      committer = { kind: 'member', ...credential };
    }
    return { group: new MlsGroup(newState, this.directory), consumed, committer };
  }

  /** Encrypts application data (an OGC message payload) for every device in the group. */
  async encrypt(
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<{ group: MlsGroup; ciphertext: string; consumed: Uint8Array[] }> {
    const cs = await ogcSuite();
    const { newState, privateMessage, consumed } = await createApplicationMessage(
      this.state,
      plaintext,
      cs,
      aad,
    );
    return {
      group: new MlsGroup(newState, this.directory),
      ciphertext: encodeMessage({
        version: 'mls10',
        wireformat: 'mls_private_message',
        privateMessage,
      }),
      consumed,
    };
  }

  /**
   * Decrypts application data and returns the authenticated sender device.
   * The sender's identity comes from the MLS ratchet tree, never from server
   * metadata; `expectedAad` binds the ciphertext to the server's message record.
   */
  async decrypt(
    ciphertext: string,
    expectedAad: Uint8Array,
  ): Promise<{
    group: MlsGroup;
    plaintext: Uint8Array;
    sender: DeviceCredential;
    consumed: Uint8Array[];
  }> {
    const cs = await ogcSuite();
    const message = decodeMessageBase64(ciphertext);
    if (message.wireformat !== 'mls_private_message') {
      throw new MlsSecurityError('Application messages must be private messages');
    }
    const pm = message.privateMessage;
    const current = this.state.groupContext.epoch;
    const historical =
      pm.epoch < current ? this.state.historicalReceiverData.get(pm.epoch) : undefined;
    if (pm.epoch > current) throw new MlsSecurityError('Message from a future epoch');
    if (pm.epoch < current && !historical) throw new MlsSecurityError('Message epoch is too old');

    const receiver = historical ?? {
      senderDataSecret: this.state.keySchedule.senderDataSecret,
      secretTree: this.state.secretTree,
      ratchetTree: this.state.ratchetTree,
      groupContext: this.state.groupContext,
    };
    const result = await unprotectPrivateMessage(
      receiver.senderDataSecret,
      pm,
      receiver.secretTree,
      receiver.ratchetTree,
      receiver.groupContext,
      this.state.clientConfig.keyRetentionConfig,
      cs,
    );
    const content = result.content.content;
    if (content.contentType !== 'application') {
      throw new MlsSecurityError('Unexpected handshake message');
    }
    if (!equalBytes(content.authenticatedData, expectedAad)) {
      throw new MlsSecurityError('Ciphertext does not belong to this message');
    }
    if (content.sender.senderType !== 'member') throw new MlsSecurityError('Unknown sender');
    const leaf = receiver.ratchetTree[content.sender.leafIndex * 2];
    const sender =
      leaf?.nodeType === 'leaf' ? parseDeviceCredential(leaf.leaf.credential) : undefined;
    if (!sender) throw new MlsSecurityError('Unknown sender');

    const newState: ClientState = historical
      ? {
          ...this.state,
          historicalReceiverData: new Map(this.state.historicalReceiverData).set(pm.epoch, {
            ...historical,
            secretTree: result.tree,
          }),
        }
      : { ...this.state, secretTree: result.tree };
    return {
      group: new MlsGroup(newState, this.directory),
      plaintext: content.applicationData,
      sender,
      consumed: result.consumed,
    };
  }
}

/** Overwrites secrets that the new state no longer needs (forward secrecy). */
export function wipeConsumed(consumed: Uint8Array[]): void {
  for (const secret of consumed) zeroOutUint8Array(secret);
}

export { OGC_CIPHERSUITE };
