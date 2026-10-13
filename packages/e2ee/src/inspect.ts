import type { LeafNode } from 'ts-mls';
import { ratchetTreeFromExtension, verifyGroupInfoSignature } from 'ts-mls/groupInfo.js';
import { makeKeyPackageRef, verifyKeyPackage } from 'ts-mls/keyPackage.js';
import { verifyLeafNodeSignatureKeyPackage } from 'ts-mls/leafNode.js';
import { equalBytes, fromUtf8, toHex } from './bytes.js';
import { type DeviceCredential, parseDeviceCredential } from './credential.js';
import { MlsSecurityError, decodeMessageBase64 } from './mls.js';
import { OGC_CIPHERSUITE, ogcSuite } from './provider.js';

/**
 * Delivery-service checks for the API. The server never holds group secrets,
 * but MLS keeps enough in the clear (RFC 9420 §6) to enforce routing and
 * membership policy: who a key package belongs to, which epoch a message is
 * for, and which devices a commit adds, removes or lets join.
 * None of these functions can reveal message content.
 */

export interface InspectedKeyPackage {
  ref: string;
  device: DeviceCredential;
  signaturePublicKey: Uint8Array;
  notAfter: bigint;
}

function leafDevice(leaf: LeafNode): DeviceCredential {
  const device = parseDeviceCredential(leaf.credential);
  if (!device) throw new MlsSecurityError('Credential is not an OGC device');
  return device;
}

/** Decodes and fully verifies a key package (signatures, ciphersuite, credential, lifetime). */
export async function inspectKeyPackage(
  encoded: string,
  now = new Date(),
): Promise<InspectedKeyPackage> {
  const cs = await ogcSuite();
  const message = decodeMessageBase64(encoded);
  if (message.wireformat !== 'mls_key_package') throw new MlsSecurityError('Not a key package');
  const kp = message.keyPackage;
  if (kp.cipherSuite !== OGC_CIPHERSUITE) throw new MlsSecurityError('Unsupported ciphersuite');
  const signaturesValid =
    (await verifyKeyPackage(kp, cs.signature)) &&
    (await verifyLeafNodeSignatureKeyPackage(kp.leafNode, cs.signature));
  if (!signaturesValid) throw new MlsSecurityError('Invalid key package signature');
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  const { notBefore, notAfter } = kp.leafNode.lifetime;
  if (seconds < notBefore || seconds > notAfter) throw new MlsSecurityError('Key package expired');
  return {
    ref: toHex(await makeKeyPackageRef(kp, cs.hash)),
    device: leafDevice(kp.leafNode),
    signaturePublicKey: kp.leafNode.signaturePublicKey,
    notAfter,
  };
}

export interface TreeMember extends DeviceCredential {
  leafIndex: number;
  signaturePublicKey: Uint8Array;
}

export interface InspectedGroupInfo {
  groupId: string;
  epoch: bigint;
  members: TreeMember[];
}

/** Decodes a GroupInfo, verifies the signer's signature, and lists the members of its tree. */
export async function inspectGroupInfo(encoded: string): Promise<InspectedGroupInfo> {
  const cs = await ogcSuite();
  const message = decodeMessageBase64(encoded);
  if (message.wireformat !== 'mls_group_info') throw new MlsSecurityError('Not a GroupInfo');
  const info = message.groupInfo;
  if (info.groupContext.cipherSuite !== OGC_CIPHERSUITE) {
    throw new MlsSecurityError('Unsupported ciphersuite');
  }
  const tree = ratchetTreeFromExtension(info);
  if (!tree) throw new MlsSecurityError('GroupInfo must include the ratchet tree');
  const members: TreeMember[] = [];
  tree.forEach((node, nodeIndex) => {
    if (node?.nodeType !== 'leaf') return;
    members.push({
      ...leafDevice(node.leaf),
      leafIndex: nodeIndex / 2,
      signaturePublicKey: node.leaf.signaturePublicKey,
    });
  });
  const signer = members.find((m) => m.leafIndex === info.signer);
  if (!signer || !(await verifyGroupInfoSignature(info, signer.signaturePublicKey, cs.signature))) {
    throw new MlsSecurityError('Invalid GroupInfo signature');
  }
  const ids = new Set(members.map((m) => m.deviceKeyId));
  if (ids.size !== members.length) throw new MlsSecurityError('Duplicate device in group');
  return { groupId: fromUtf8(info.groupContext.groupId), epoch: info.groupContext.epoch, members };
}

export type InspectedProposal =
  | { type: 'add'; device: DeviceCredential; signaturePublicKey: Uint8Array; keyPackageRef: string }
  | { type: 'remove'; leafIndex: number }
  | { type: 'update' }
  | { type: 'external_init' };

export interface InspectedCommit {
  groupId: string;
  /** The epoch the commit was created in; applying it produces `epoch + 1`. */
  epoch: bigint;
  sender: { type: 'member'; leafIndex: number } | { type: 'external'; device: DeviceCredential };
  proposals: InspectedProposal[];
}

/** Decodes a commit (which OGC always sends as a PublicMessage) and summarises its effects. */
export async function inspectCommit(encoded: string): Promise<InspectedCommit> {
  const cs = await ogcSuite();
  const message = decodeMessageBase64(encoded);
  if (message.wireformat !== 'mls_public_message') {
    throw new MlsSecurityError('Commits must be public messages');
  }
  const { content } = message.publicMessage;
  if (content.contentType !== 'commit') throw new MlsSecurityError('Not a commit');

  const proposals: InspectedProposal[] = [];
  for (const entry of content.commit.proposals) {
    if (entry.proposalOrRefType !== 'proposal') {
      throw new MlsSecurityError('Proposal references are not supported');
    }
    const proposal = entry.proposal;
    switch (proposal.proposalType) {
      case 'add': {
        const kp = proposal.add.keyPackage;
        if (!(await verifyKeyPackage(kp, cs.signature))) {
          throw new MlsSecurityError('Invalid key package signature');
        }
        proposals.push({
          type: 'add',
          device: leafDevice(kp.leafNode),
          signaturePublicKey: kp.leafNode.signaturePublicKey,
          keyPackageRef: toHex(await makeKeyPackageRef(kp, cs.hash)),
        });
        break;
      }
      case 'remove':
        proposals.push({ type: 'remove', leafIndex: proposal.remove.removed });
        break;
      case 'update':
        proposals.push({ type: 'update' });
        break;
      case 'external_init':
        proposals.push({ type: 'external_init' });
        break;
      default:
        throw new MlsSecurityError('Proposal type not allowed');
    }
  }

  let sender: InspectedCommit['sender'];
  if (content.sender.senderType === 'member') {
    sender = { type: 'member', leafIndex: content.sender.leafIndex };
  } else if (content.sender.senderType === 'new_member_commit') {
    const leaf = content.commit.path?.leafNode;
    if (!leaf) throw new MlsSecurityError('External commit without a path');
    sender = { type: 'external', device: leafDevice(leaf) };
  } else {
    throw new MlsSecurityError('Sender type not allowed');
  }
  return { groupId: fromUtf8(content.groupId), epoch: content.epoch, sender, proposals };
}

export interface InspectedApplicationMessage {
  groupId: string;
  epoch: bigint;
  authenticatedData: Uint8Array;
}

/** Reads the cleartext header of an encrypted application message (never its content). */
export function inspectApplicationMessage(encoded: string): InspectedApplicationMessage {
  const message = decodeMessageBase64(encoded);
  if (message.wireformat !== 'mls_private_message') {
    throw new MlsSecurityError('Application messages must be private messages');
  }
  const pm = message.privateMessage;
  if (pm.contentType !== 'application') throw new MlsSecurityError('Not an application message');
  return {
    groupId: fromUtf8(pm.groupId),
    epoch: pm.epoch,
    authenticatedData: pm.authenticatedData,
  };
}

/** Lists the key package references a Welcome is addressed to. */
export function inspectWelcome(encoded: string): { keyPackageRefs: string[] } {
  const message = decodeMessageBase64(encoded);
  if (message.wireformat !== 'mls_welcome') throw new MlsSecurityError('Not a Welcome message');
  if (message.welcome.cipherSuite !== OGC_CIPHERSUITE) {
    throw new MlsSecurityError('Unsupported ciphersuite');
  }
  return { keyPackageRefs: message.welcome.secrets.map((s) => toHex(s.newMember)) };
}

export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return equalBytes(a, b);
}
