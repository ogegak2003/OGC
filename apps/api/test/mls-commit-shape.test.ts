import {
  type DirectoryDevice,
  type LocalDevice,
  MlsGroup,
  fromBase64,
  generateKeyPackages,
  generateSigningKeyPair,
  toBase64,
} from '@ogc/e2ee';
import { TransportError } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// ts-mls is a dependency of @ogc/e2ee only: use that installed copy (no new dependency).
import * as tsMls from '../../../packages/e2ee/node_modules/ts-mls/dist/src/index.js';
import type {
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
 * Member commits must add or remove devices: empty and update-only commits would only advance
 * the epoch (stalling every member's messages), so the server rejects them from the parsed
 * proposals. Commits are built and altered by hand, like mls-policy.test.ts; the server parses
 * commits without verifying their signatures (members do), so altered proposals reach the policy.
 */
describe('MLS member commits must change membership', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let bobDevice: TestDevice;
  let conversationId: string;

  interface Raw {
    device: LocalDevice;
    transport: HttpTransport;
  }

  async function rawDevice(user: TestUser): Promise<Raw> {
    const { accessToken } = await nativeTokens(t, user.email);
    const transport = new HttpTransport(baseUrl, accessToken);
    const signing = await generateSigningKeyPair();
    const { deviceKeyId } = await transport.registerDeviceKey(toBase64(signing.publicKey));
    return { device: { ogcId: user.ogcId, deviceKeyId, signing }, transport };
  }

  const directoryOf = async (transport: HttpTransport): Promise<DirectoryDevice[]> =>
    (await transport.directory(conversationId)).map((d) => ({
      ogcId: d.ogcId,
      deviceKeyId: d.deviceKeyId,
      signaturePublicKey: fromBase64(d.signaturePublicKey),
    }));

  /** A raw device of Alice that joined the group; returns it with its current group state. */
  async function member(): Promise<Raw & { group: MlsGroup }> {
    const raw = await rawDevice(alice);
    const server = await raw.transport.mlsGroup(conversationId);
    const joined = await MlsGroup.joinExternal(
      raw.device,
      server.groupInfo ?? '',
      await directoryOf(raw.transport),
    );
    await raw.transport.submitCommit(conversationId, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    return { ...raw, group: joined.group };
  }

  /** A device of `user` with a published, then claimed, key package. */
  async function addable(user: TestUser, claimer: Raw): Promise<{ raw: Raw; keyPackage: string }> {
    const raw = await rawDevice(user);
    const [kp] = await generateKeyPackages(raw.device, 1);
    await raw.transport.uploadKeyPackages([kp?.publicKey ?? '']);
    const [claimed] = await claimer.transport.claimKeyPackages(conversationId, [
      raw.device.deviceKeyId,
    ]);
    return { raw, keyPackage: claimed?.keyPackage ?? '' };
  }

  const decode = (text: string): MLSMessage => {
    const decoded = tsMls.decodeMlsMessage(fromBase64(text), 0);
    if (!decoded) throw new Error('undecodable');
    return decoded[0];
  };
  const encode = (message: MLSMessage): string => toBase64(tsMls.encodeMlsMessage(message));

  /** Replaces the commit's proposals (read by the server without a signature check). */
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

  /**
   * A well-formed update proposal: the device's leaf data from a fresh key package, re-labelled
   * as an update leaf (no lifetime). The server only decodes it; members would check signatures.
   */
  async function updateProposal(device: LocalDevice): Promise<Proposal> {
    const [kp] = await generateKeyPackages(device, 1);
    const message = decode(kp?.publicKey ?? '');
    if (message.wireformat !== 'mls_key_package') throw new Error('not a key package');
    const { lifetime: _lifetime, ...leaf } = message.keyPackage.leafNode;
    return {
      proposalType: 'update',
      update: { leafNode: { ...leaf, leafNodeSource: 'update' } },
    };
  }

  async function outcome(p: Promise<unknown>) {
    try {
      await p;
      return { status: 201, message: '' };
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      return { status: error.status, message: error.message, code: error.code };
    }
  }

  const submit = (raw: Raw, epoch: bigint, result: Awaited<ReturnType<MlsGroup['commit']>>) =>
    raw.transport.submitCommit(conversationId, {
      epoch: Number(epoch),
      commit: result.commit,
      groupInfo: result.groupInfo,
      ...(result.welcome ? { welcome: result.welcome } : {}),
    });

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob] = await Promise.all([signedInUser(t, 'Alice'), signedInUser(t, 'Bob')]);
    await makeContacts(t, alice, bob);
    const aliceDevice = await newDevice(t, baseUrl, alice);
    bobDevice = await newDevice(t, baseUrl, bob);
    const conversation: ConversationView = await aliceDevice.client.openDirect(bob.ogcId);
    conversationId = conversation.id;
    await aliceDevice.client.send(conversationId, { text: 'group established' });
  });

  afterAll(async () => {
    await t.close();
  });

  const MUST_CHANGE = 'Commits must add or remove devices';

  it('rejects an empty member commit', async () => {
    const r = await member();
    const empty = await r.group.commit({});
    expect(await outcome(submit(r, r.group.epoch, empty))).toMatchObject({
      status: 400,
      code: 'INVALID_MLS_MESSAGE',
      message: MUST_CHANGE,
    });
  });

  it('rejects update-only and mixed commits', async () => {
    const r = await member();
    const update = await updateProposal(r.device);
    const empty = await r.group.commit({});
    const updateOnly = withProposals(empty.commit, () => [update]);
    expect(
      await outcome(
        r.transport.submitCommit(conversationId, {
          epoch: Number(r.group.epoch),
          commit: updateOnly,
          groupInfo: empty.groupInfo,
        }),
      ),
    ).toMatchObject({ status: 400, message: MUST_CHANGE });

    // An add with an update smuggled in is refused as a whole.
    const { keyPackage } = await addable(alice, r);
    const add = await r.group
      .withDirectory(await directoryOf(r.transport))
      .commit({ add: [keyPackage] });
    const mixed = withProposals(add.commit, (ps) => [...ps, update]);
    expect(
      await outcome(
        r.transport.submitCommit(conversationId, {
          epoch: Number(r.group.epoch),
          commit: mixed,
          groupInfo: add.groupInfo,
          ...(add.welcome ? { welcome: add.welcome } : {}),
        }),
      ),
    ).toMatchObject({ status: 400, message: MUST_CHANGE });
  });

  it('accepts valid add and remove commits, subject to the existing checks', async () => {
    const r = await member();
    const { raw: added, keyPackage } = await addable(alice, r);
    const add = await r.group
      .withDirectory(await directoryOf(r.transport))
      .commit({ add: [keyPackage] });
    expect((await outcome(submit(r, r.group.epoch, add))).status).toBe(201);
    let group = add.group;

    // Removing another person's active device stays forbidden.
    const removeBob = await group.commit({
      removeDeviceKeyIds: [bobDevice.client.deviceKeyId ?? ''],
    });
    expect(await outcome(submit(r, group.epoch, removeBob))).toMatchObject({ status: 403 });

    // Removing one's own device is allowed.
    const removeOwn = await group.commit({ removeDeviceKeyIds: [added.device.deviceKeyId] });
    expect((await outcome(submit(r, group.epoch, removeOwn))).status).toBe(201);
    group = removeOwn.group;
    const tree = (await r.transport.mlsGroup(conversationId)).members;
    expect(tree).not.toContain(added.device.deviceKeyId);
    expect(tree).toContain(bobDevice.client.deviceKeyId);
    expect(group.epoch).toBeGreaterThan(0n);
  });

  it('still rejects duplicate devices, disallowed proposals and bad resync shapes', async () => {
    const r = await member();
    // Two key packages of one new device in one commit: the device would be in the tree twice.
    const twice = await rawDevice(alice);
    const kps = await generateKeyPackages(twice.device, 2);
    await twice.transport.uploadKeyPackages(kps.map((kp) => kp.publicKey));
    const claimedA = await r.transport.claimKeyPackages(conversationId, [twice.device.deviceKeyId]);
    const claimedB = await r.transport.claimKeyPackages(conversationId, [twice.device.deviceKeyId]);
    const duplicateAdd = await r.group
      .withDirectory(await directoryOf(r.transport))
      .commit({ add: [claimedA[0]?.keyPackage ?? '', claimedB[0]?.keyPackage ?? ''] })
      .then(
        (result) => outcome(submit(r, r.group.epoch, result)),
        () => ({ status: 0, message: 'refused by the client' }),
      );
    expect(duplicateAdd.status).not.toBe(201);

    // A proposal type OGC never allows.
    const empty = await r.group.commit({});
    const extensions = withProposals(empty.commit, () => [
      {
        proposalType: 'group_context_extensions',
        groupContextExtensions: { extensions: [] },
      } as unknown as Proposal,
    ]);
    expect(
      (
        await outcome(
          r.transport.submitCommit(conversationId, {
            epoch: Number(r.group.epoch),
            commit: extensions,
            groupInfo: empty.groupInfo,
          }),
        )
      ).status,
    ).toBe(400);

    // A resync with an extra update proposal is no resync.
    const server = await r.transport.mlsGroup(conversationId);
    const rejoin = await MlsGroup.joinExternal(
      r.device,
      server.groupInfo ?? '',
      await directoryOf(r.transport),
    );
    expect(rejoin.resynced).toBe(true);
    const update = await updateProposal(r.device);
    const padded = withProposals(rejoin.commit, (ps) => [...ps, update]);
    expect(
      await outcome(
        r.transport.submitCommit(conversationId, {
          epoch: server.epoch,
          commit: padded,
          groupInfo: rejoin.groupInfo,
        }),
      ),
    ).toMatchObject({ status: 400, message: 'This device is already a member' });
    // The genuine resync is still accepted.
    expect(
      (
        await outcome(
          r.transport.submitCommit(conversationId, {
            epoch: server.epoch,
            commit: rejoin.commit,
            groupInfo: rejoin.groupInfo,
          }),
        )
      ).status,
    ).toBe(201);
  });
});
