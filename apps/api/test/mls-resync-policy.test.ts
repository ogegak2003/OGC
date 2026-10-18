import {
  type DirectoryDevice,
  type LocalDevice,
  MlsGroup,
  fromBase64,
  generateKeyPackages,
  generateSigningKeyPair,
  inspectGroupInfo,
  ogcSuite,
  toBase64,
} from '@ogc/e2ee';
import type { ConversationView } from '@ogc/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// ts-mls is a dependency of @ogc/e2ee only: use that installed copy (no new dependency).
import * as tsMls from '../../../packages/e2ee/node_modules/ts-mls/dist/src/index.js';
import type {
  Credential,
  MLSMessage,
  Proposal,
} from '../../../packages/e2ee/node_modules/ts-mls/dist/src/index.js';
import { HttpTransport, type TestDevice, listen, newDevice } from './support/messaging.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  nativeTokens,
  signedInUser,
} from './support/test-app.js';

/**
 * Server policy for external-commit resync (RFC 9420 §12.4.3.2): a device still in the tree
 * may rejoin only by removing exactly its own leaf. Like mls-policy.test.ts, these tests act as
 * a misbehaving client that speaks valid MLS: commits are built and altered by hand. The server
 * parses commits but does not verify their signatures (members do), so altered proposals reach
 * the policy checks — which is what these tests exercise.
 */

describe('MLS resync policy', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let aliceDevice: TestDevice;
  let bobDevice: TestDevice;
  let conversation: ConversationView;

  async function rawDevice(
    user: TestUser,
  ): Promise<{ device: LocalDevice; transport: HttpTransport }> {
    const { accessToken } = await nativeTokens(t, user.email);
    const transport = new HttpTransport(baseUrl, accessToken);
    const signing = await generateSigningKeyPair();
    const { deviceKeyId } = await transport.registerDeviceKey(toBase64(signing.publicKey));
    return { device: { ogcId: user.ogcId, deviceKeyId, signing }, transport };
  }

  const directoryOf = async (transport: HttpTransport): Promise<DirectoryDevice[]> =>
    (await transport.directory(conversation.id)).map((d) => ({
      ogcId: d.ogcId,
      deviceKeyId: d.deviceKeyId,
      signaturePublicKey: fromBase64(d.signaturePublicKey),
    }));

  /** A raw device of Alice that joined the group (it is now in the published tree). */
  async function member() {
    const raw = await rawDevice(alice);
    const server = await raw.transport.mlsGroup(conversation.id);
    const joined = await MlsGroup.joinExternal(
      raw.device,
      server.groupInfo ?? '',
      await directoryOf(raw.transport),
    );
    expect(joined.resynced).toBe(false);
    await raw.transport.submitCommit(conversation.id, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    return raw;
  }

  /** The device rejoins from the published GroupInfo (as after losing its group state). */
  async function rejoin(raw: { device: LocalDevice; transport: HttpTransport }) {
    const server = await raw.transport.mlsGroup(conversation.id);
    const joined = await MlsGroup.joinExternal(
      raw.device,
      server.groupInfo ?? '',
      await directoryOf(raw.transport),
    );
    const previous = await inspectGroupInfo(server.groupInfo ?? '');
    return { server, joined, previous };
  }

  const decode = (text: string): MLSMessage => {
    const decoded = tsMls.decodeMlsMessage(fromBase64(text), 0);
    if (!decoded) throw new Error('undecodable');
    return decoded[0];
  };
  const encode = (message: MLSMessage): string => toBase64(tsMls.encodeMlsMessage(message));

  /** Replaces the commit's proposals (the server reads them without verifying the signature). */
  function withProposals(commit: string, edit: (proposals: Proposal[]) => Proposal[]): string {
    const message = decode(commit);
    if (message.wireformat !== 'mls_public_message') throw new Error('not public');
    const content = message.publicMessage.content;
    if (content.contentType !== 'commit') throw new Error('not a commit');
    const proposals = content.commit.proposals.flatMap((p) =>
      p.proposalOrRefType === 'proposal' ? [p.proposal] : [],
    );
    return encode({
      ...message,
      publicMessage: {
        ...message.publicMessage,
        content: {
          ...content,
          commit: {
            ...content.commit,
            proposals: edit(proposals).map((proposal) => ({
              proposalOrRefType: 'proposal' as const,
              proposal,
            })),
          },
        },
      },
    });
  }
  const remove = (leafIndex: number): Proposal => ({
    proposalType: 'remove',
    remove: { removed: leafIndex },
  });

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob] = await Promise.all([signedInUser(t, 'Alice'), signedInUser(t, 'Bob')]);
    await makeContacts(t, alice, bob);
    aliceDevice = await newDevice(t, baseUrl, alice);
    bobDevice = await newDevice(t, baseUrl, bob);
    conversation = await aliceDevice.client.openDirect(bob.ogcId);
    await aliceDevice.client.send(conversation.id, { text: 'group established' });
  });

  afterAll(async () => {
    await t.close();
  });

  const bobLeaf = (previous: Awaited<ReturnType<typeof inspectGroupInfo>>): number => {
    const leaf = previous.members.find((m) => m.deviceKeyId === bobDevice.client.deviceKeyId);
    if (!leaf) throw new Error('Bob is not in the tree');
    return leaf.leafIndex;
  };

  it('accepts a self-resync: the device stays in the tree exactly once', async () => {
    const raw = await member();
    const { server, joined } = await rejoin(raw);
    expect(joined.resynced).toBe(true);
    await raw.transport.submitCommit(conversation.id, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    const after = await raw.transport.mlsGroup(conversation.id);
    expect(after.epoch).toBe(server.epoch + 1);
    expect(after.members.filter((id) => id === raw.device.deviceKeyId)).toHaveLength(1);
    // Every other device is still there.
    expect(after.members).toContain(bobDevice.client.deviceKeyId);
  });

  it('still rejects a plain external join from a device already in the tree', async () => {
    const raw = await member();
    const { server, joined } = await rejoin(raw);
    // The resync with its remove dropped: a second appearance of the same device.
    const plain = withProposals(joined.commit, (ps) =>
      ps.filter((p) => p.proposalType !== 'remove'),
    );
    await expect(
      raw.transport.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: plain,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'This device is already a member' });
  });

  it('rejects a rejoin that removes another device’s leaf instead of its own', async () => {
    const raw = await member();
    const { server, joined, previous } = await rejoin(raw);
    const swapped = withProposals(joined.commit, (ps) =>
      ps.map((p) => (p.proposalType === 'remove' ? remove(bobLeaf(previous)) : p)),
    );
    await expect(
      raw.transport.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: swapped,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'This device is already a member' });
  });

  it('rejects a rejoin that removes more than its own leaf', async () => {
    const raw = await member();
    const { server, joined, previous } = await rejoin(raw);
    const greedy = withProposals(joined.commit, (ps) => [...ps, remove(bobLeaf(previous))]);
    await expect(
      raw.transport.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: greedy,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'This device is already a member' });
  });

  it('rejects an external join of a new device that removes anyone', async () => {
    const raw = await rawDevice(alice);
    const server = await raw.transport.mlsGroup(conversation.id);
    const previous = await inspectGroupInfo(server.groupInfo ?? '');
    const joined = await MlsGroup.joinExternal(
      raw.device,
      server.groupInfo ?? '',
      await directoryOf(raw.transport),
    );
    expect(joined.resynced).toBe(false);
    const hostile = withProposals(joined.commit, (ps) => [remove(bobLeaf(previous)), ...ps]);
    await expect(
      raw.transport.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: hostile,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'An external join cannot remove members' });
  });

  it('rejects a resync on behalf of another device', async () => {
    const raw = await member();
    const { server, joined } = await rejoin(raw);
    const { accessToken } = await nativeTokens(t, alice.email);
    const other = new HttpTransport(baseUrl, accessToken);
    await other.registerDeviceKey(toBase64((await generateSigningKeyPair()).publicKey));
    await expect(
      other.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({
      // The resulting tree is the original device's, so the submitter is not in it: refused
      // before the sender check ("Devices can only join for themselves") is even reached.
      status: 403,
      message: 'The committing device must be a member of the group',
    });
  });

  it('rejects a resync whose old leaf does not hold the device’s registered key', async () => {
    const raw = await member();
    // The API never gives a device ID a second key (replacement issues a new ID), so this
    // state is set up directly: the registered key now differs from the key in the tree.
    const replacement = await generateSigningKeyPair();
    await t.prisma.deviceKey.update({
      where: { id: raw.device.deviceKeyId },
      data: { signaturePublicKey: Buffer.from(replacement.publicKey) },
    });
    const device: LocalDevice = { ...raw.device, signing: replacement };
    const server = await raw.transport.mlsGroup(conversation.id);
    // The client refuses this resync itself…
    await expect(
      MlsGroup.joinExternal(device, server.groupInfo ?? '', await directoryOf(raw.transport)),
    ).rejects.toThrow(/different identity or key/);

    // …so a hand-built one: ts-mls told to treat the leaf with this device ID as the former leaf.
    const cs = await ogcSuite();
    const [kp] = await generateKeyPackages(device, 1);
    const stored = JSON.parse(kp?.privateKey ?? '{}') as Record<string, string>;
    const keyMessage = decode(stored.keyPackage ?? '');
    const info = decode(server.groupInfo ?? '');
    if (keyMessage.wireformat !== 'mls_key_package' || info.wireformat !== 'mls_group_info') {
      throw new Error('unexpected message types');
    }
    const identity = (credential: Credential) =>
      credential.credentialType === 'basic' ? toBase64(credential.identity) : '';
    const { newState, publicMessage } = await tsMls.joinGroupExternal(
      info.groupInfo,
      keyMessage.keyPackage,
      {
        initPrivateKey: fromBase64(stored.init ?? ''),
        hpkePrivateKey: fromBase64(stored.hpke ?? ''),
        signaturePrivateKey: fromBase64(stored.signature ?? ''),
      },
      true,
      cs,
      undefined,
      {
        keyRetentionConfig: tsMls.defaultKeyRetentionConfig,
        lifetimeConfig: tsMls.defaultLifetimeConfig,
        paddingConfig: tsMls.defaultPaddingConfig,
        authService: { validateCredential: () => Promise.resolve(true) },
        keyPackageEqualityConfig: {
          compareKeyPackages: () => false,
          compareKeyPackageToLeafNode: (a, leaf) =>
            identity(a.leafNode.credential) === identity(leaf.credential),
        },
      },
    );
    const groupInfo = await tsMls.createGroupInfoWithExternalPubAndRatchetTree(newState, [], cs);
    await expect(
      raw.transport.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: encode({ version: 'mls10', wireformat: 'mls_public_message', publicMessage }),
        groupInfo: encode({ version: 'mls10', wireformat: 'mls_group_info', groupInfo }),
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: 'The rejoining device does not match its registered key',
    });
  });
});
