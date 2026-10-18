import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from './bytes.js';
import { inspectCommit, inspectGroupInfo } from './inspect.js';
import {
  type GeneratedKeyPackage,
  type LocalDevice,
  MlsGroup,
  MlsSecurityError,
  MlsSoleMemberError,
  generateKeyPackages,
  messageAad,
} from './mls.js';
import { directoryOf, makeDevice } from './test-helpers.js';

/**
 * Resync (RFC 9420 §12.4.3.2): a device still in the group's tree that lost its group state
 * rejoins by an external commit that removes exactly its own old leaf.
 */
const CONV = '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
const ALICE = 'OGC482731905';
const BOB = 'OGC193847562';
/** ts-mls never returns when asked to resync a missing leaf: this bound turns that into a failure. */
const BOUNDED = 20_000;

async function keyPackage(device: LocalDevice): Promise<GeneratedKeyPackage> {
  const [kp] = await generateKeyPackages(device, 1);
  if (!kp) throw new Error('no key package');
  return kp;
}

/** Alice creates the group and adds Bob; returns both groups and the published GroupInfo. */
async function aliceAndBob() {
  const alice = await makeDevice(ALICE);
  const bob = await makeDevice(BOB);
  const directory = directoryOf(alice, bob);
  const bobKp = await keyPackage(bob);
  const created = await MlsGroup.create(alice, CONV, directory);
  const added = await created.commit({ add: [bobKp.publicKey] });
  if (!added.welcome) throw new Error('no welcome');
  const bobGroup = await MlsGroup.joinFromWelcome(added.welcome, bobKp, directory);
  return { alice, bob, directory, aliceGroup: added.group, bobGroup, groupInfo: added.groupInfo };
}

const leavesOf = (group: MlsGroup, deviceKeyId: string) =>
  group.members().filter((m) => m.deviceKeyId === deviceKeyId);

describe('MLS resync of a device still in the tree', () => {
  it(
    'removes exactly the device’s old leaf, leaves it once, and other members accept it',
    async () => {
      const s = await aliceAndBob();
      const oldLeaf = leavesOf(s.bobGroup, s.bob.deviceKeyId)[0]?.leafIndex;
      // Bob's device lost its group state; the published tree still holds it.
      const rejoined = await MlsGroup.joinExternal(s.bob, s.groupInfo, s.directory);
      expect(rejoined.resynced).toBe(true);

      const commit = await inspectCommit(rejoined.commit);
      expect(commit.sender).toMatchObject({ type: 'external' });
      expect(commit.proposals).toEqual([
        { type: 'remove', leafIndex: oldLeaf },
        { type: 'external_init' },
      ]);
      const next = await inspectGroupInfo(rejoined.groupInfo);
      expect(next.members.filter((m) => m.deviceKeyId === s.bob.deviceKeyId)).toHaveLength(1);

      const processed = await s.aliceGroup.processCommit(rejoined.commit);
      expect(processed.committer).toEqual({ kind: 'external' });
      const alice = processed.group;
      expect(alice.epoch).toBe(2n);
      expect(leavesOf(alice, s.bob.deviceKeyId)).toHaveLength(1);
      expect(alice.members()).toHaveLength(2);

      // Both directions work in the new epoch; the lost state cannot read it.
      const aad = messageAad(CONV, 'r-1');
      const { ciphertext } = await alice.encrypt(utf8('welcome back'), aad);
      expect(fromUtf8((await rejoined.group.decrypt(ciphertext, aad)).plaintext)).toBe(
        'welcome back',
      );
      await expect(s.bobGroup.decrypt(ciphertext, aad)).rejects.toThrow();
      const reply = messageAad(CONV, 'r-2');
      const sent = await rejoined.group.encrypt(utf8('thanks'), reply);
      expect(fromUtf8((await alice.decrypt(sent.ciphertext, reply)).plaintext)).toBe('thanks');
    },
    BOUNDED,
  );

  it(
    'keeps the normal external join for a device absent from the tree',
    async () => {
      const s = await aliceAndBob();
      const bobLaptop = await makeDevice(BOB);
      const directory = [...s.directory, ...directoryOf(bobLaptop)];
      const joined = await MlsGroup.joinExternal(bobLaptop, s.groupInfo, directory);
      expect(joined.resynced).toBe(false);
      expect((await inspectCommit(joined.commit)).proposals).toEqual([{ type: 'external_init' }]);
      const alice = (await s.aliceGroup.withDirectory(directory).processCommit(joined.commit))
        .group;
      expect(alice.members()).toHaveLength(3);
    },
    BOUNDED,
  );

  it(
    'refuses to resync a device that is not in the tree (never reaching the ts-mls hang)',
    async () => {
      const s = await aliceAndBob();
      const stranger = await makeDevice(BOB);
      const directory = [...s.directory, ...directoryOf(stranger)];
      await expect(
        MlsGroup.joinExternal(stranger, s.groupInfo, directory, { requireResync: true }),
      ).rejects.toThrow(MlsSecurityError);
    },
    BOUNDED,
  );

  describe('a device that is the only member of its group', () => {
    /** A typed, recoverable refusal — never a security error, and never the ts-mls failure. */
    const expectSoleMember = async (attempt: Promise<unknown>) => {
      const error: unknown = await attempt.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MlsSoleMemberError);
      expect(error).not.toBeInstanceOf(MlsSecurityError);
    };

    it(
      'is refused with MlsSoleMemberError when it created the group alone',
      async () => {
        const alone = await makeDevice(ALICE);
        const directory = directoryOf(alone);
        const group = await MlsGroup.create(alone, CONV, directory);
        await expectSoleMember(MlsGroup.joinExternal(alone, await group.groupInfo(), directory));
      },
      BOUNDED,
    );

    it(
      'is refused when every other member was removed (its leaf at index 0)',
      async () => {
        const s = await aliceAndBob();
        const removed = await s.aliceGroup.commit({ removeDeviceKeyIds: [s.bob.deviceKeyId] });
        await expectSoleMember(MlsGroup.joinExternal(s.alice, removed.groupInfo, s.directory));
      },
      BOUNDED,
    );

    it(
      'is refused when its leaf is the only one but not the first (leaf 0 blank)',
      async () => {
        const s = await aliceAndBob();
        // Bob (leaf 1) removes Alice (leaf 0): Bob's leaf is now the only non-blank leaf.
        const removed = await s.bobGroup.commit({ removeDeviceKeyIds: [s.alice.deviceKeyId] });
        const leaves = (await inspectGroupInfo(removed.groupInfo)).members;
        expect(leaves.map((m) => m.leafIndex)).toEqual([1]);
        await expectSoleMember(MlsGroup.joinExternal(s.bob, removed.groupInfo, s.directory));
      },
      BOUNDED,
    );

    it(
      'still fails as a security error when the sole leaf is not verifiably its own',
      async () => {
        const alone = await makeDevice(ALICE);
        const directory = directoryOf(alone);
        const group = await MlsGroup.create(alone, CONV, directory);
        const groupInfo = await group.groupInfo();
        // Same device ID, another key: ambiguous, so not the recoverable case.
        const impostor: LocalDevice = {
          ...(await makeDevice(ALICE)),
          deviceKeyId: alone.deviceKeyId,
        };
        await expect(MlsGroup.joinExternal(impostor, groupInfo, directory)).rejects.toThrow(
          MlsSecurityError,
        );
        // Same key under another device ID: ambiguous too.
        const twin: LocalDevice = { ...alone, deviceKeyId: crypto.randomUUID() };
        await expect(
          MlsGroup.joinExternal(twin, groupInfo, [...directory, ...directoryOf(twin)]),
        ).rejects.toThrow(MlsSecurityError);
        // Absent from the tree: a normal join, never this error.
        const other = await makeDevice(BOB);
        const joined = await MlsGroup.joinExternal(other, groupInfo, [
          ...directory,
          ...directoryOf(other),
        ]);
        expect(joined.resynced).toBe(false);
      },
      BOUNDED,
    );

    it(
      'can resync as soon as another device has joined',
      async () => {
        const alone = await makeDevice(ALICE);
        const laptop = await makeDevice(ALICE);
        const directory = directoryOf(alone, laptop);
        const group = await MlsGroup.create(alone, CONV, directory);
        const joined = await MlsGroup.joinExternal(laptop, await group.groupInfo(), directory);
        const rejoined = await MlsGroup.joinExternal(alone, joined.groupInfo, directory);
        expect(rejoined.resynced).toBe(true);
        const accepted = await joined.group.processCommit(rejoined.commit);
        expect(accepted.group.members()).toHaveLength(2);
      },
      BOUNDED,
    );
  });

  it(
    'fails safely when the tree holds this device’s ID with another key',
    async () => {
      const s = await aliceAndBob();
      // Same device key ID, different signature key (e.g. a re-registered key).
      const impostor: LocalDevice = { ...(await makeDevice(BOB)), deviceKeyId: s.bob.deviceKeyId };
      await expect(MlsGroup.joinExternal(impostor, s.groupInfo, s.directory)).rejects.toThrow(
        /different identity or key/,
      );
    },
    BOUNDED,
  );

  it(
    'fails safely when the tree holds this device’s key under another identity',
    async () => {
      const s = await aliceAndBob();
      // Bob's signature key presented as a different device.
      const twin: LocalDevice = { ...s.bob, deviceKeyId: crypto.randomUUID() };
      const directory = [...s.directory, ...directoryOf(twin)];
      await expect(MlsGroup.joinExternal(twin, s.groupInfo, directory)).rejects.toThrow(
        /different identity or key/,
      );
      // Same key and device ID, but another account.
      const otherAccount: LocalDevice = { ...s.bob, ogcId: ALICE };
      await expect(MlsGroup.joinExternal(otherAccount, s.groupInfo, s.directory)).rejects.toThrow(
        /different identity or key/,
      );
    },
    BOUNDED,
  );
});
