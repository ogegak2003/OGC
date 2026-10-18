import { describe, expect, it } from 'vitest';
import { fromUtf8, toBase64, utf8 } from './bytes.js';
import {
  inspectApplicationMessage,
  inspectCommit,
  inspectGroupInfo,
  inspectKeyPackage,
  inspectWelcome,
} from './inspect.js';
import {
  type GeneratedKeyPackage,
  type LocalDevice,
  MlsGroup,
  MlsSecurityError,
  editAad,
  generateKeyPackages,
  messageAad,
} from './mls.js';
import { directoryOf, makeDevice } from './test-helpers.js';

const CONV = '0d4c9f5e-8a5b-4c1e-9a7d-3f2b1c0e9d8a';
const ALICE = 'OGC482731905';
const BOB = 'OGC193847562';
const MALLORY = 'OGC555000111';

async function keyPackage(device: LocalDevice): Promise<GeneratedKeyPackage> {
  const [kp] = await generateKeyPackages(device, 1);
  if (!kp) throw new Error('no key package');
  return kp;
}

/** Alice (phone) creates the conversation group and adds Bob's two devices. */
async function aliceAndBob() {
  const alice = await makeDevice(ALICE);
  const bobWeb = await makeDevice(BOB);
  const bobPhone = await makeDevice(BOB);
  const directory = directoryOf(alice, bobWeb, bobPhone);
  const bobWebKp = await keyPackage(bobWeb);
  const bobPhoneKp = await keyPackage(bobPhone);

  const created = await MlsGroup.create(alice, CONV, directory);
  const commit = await created.commit({ add: [bobWebKp.publicKey, bobPhoneKp.publicKey] });
  if (!commit.welcome) throw new Error('expected a welcome');
  const bobWebGroup = await MlsGroup.joinFromWelcome(commit.welcome, bobWebKp, directory);
  const bobPhoneGroup = await MlsGroup.joinFromWelcome(commit.welcome, bobPhoneKp, directory);
  return {
    alice,
    bobWeb,
    bobPhone,
    directory,
    commit,
    aliceGroup: commit.group,
    bobWebGroup,
    bobPhoneGroup,
  };
}

describe('MLS conversation groups', () => {
  it('lets every device of both participants decrypt, and identifies the sender from the tree', async () => {
    const s = await aliceAndBob();
    expect(s.aliceGroup.epoch).toBe(1n);
    expect(s.bobWebGroup.epoch).toBe(1n);
    expect(
      s.aliceGroup
        .members()
        .map((m) => m.ogcId)
        .sort(),
    ).toEqual([BOB, BOB, ALICE].sort());

    const aad = messageAad(CONV, 'c-1');
    const sent = await s.aliceGroup.encrypt(utf8('Hello Bob 👋'), aad);
    const onWeb = await s.bobWebGroup.decrypt(sent.ciphertext, aad);
    const onPhone = await s.bobPhoneGroup.decrypt(sent.ciphertext, aad);
    expect(fromUtf8(onWeb.plaintext)).toBe('Hello Bob 👋');
    expect(fromUtf8(onPhone.plaintext)).toBe('Hello Bob 👋');
    expect(onWeb.sender).toEqual({ ogcId: ALICE, deviceKeyId: s.alice.deviceKeyId });

    // Bob's phone replies; Alice and Bob's other device both read it.
    const replyAad = messageAad(CONV, 'c-2');
    const reply = await onPhone.group.encrypt(utf8('Hi Alice'), replyAad);
    expect(fromUtf8((await sent.group.decrypt(reply.ciphertext, replyAad)).plaintext)).toBe(
      'Hi Alice',
    );
    const webSees = await onWeb.group.decrypt(reply.ciphertext, replyAad);
    expect(webSees.sender).toEqual({ ogcId: BOB, deviceKeyId: s.bobPhone.deviceKeyId });
  });

  it('never puts plaintext on the wire', async () => {
    const s = await aliceAndBob();
    const secret = 'my bank PIN is 4921';
    const { ciphertext } = await s.aliceGroup.encrypt(utf8(secret), messageAad(CONV, 'c-1'));
    expect(ciphertext).not.toContain(secret);
    expect(atob(ciphertext)).not.toContain(secret);
    expect(ciphertext).not.toContain(toBase64(utf8(secret)));
  });

  it('rejects ciphertext replayed under a different message ID (AAD binding)', async () => {
    const s = await aliceAndBob();
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('pay 10'), messageAad(CONV, 'c-1'));
    await expect(s.bobWebGroup.decrypt(ciphertext, messageAad(CONV, 'c-other'))).rejects.toThrow(
      MlsSecurityError,
    );
    await expect(s.bobWebGroup.decrypt(ciphertext, editAad(CONV, 'c-1', 1))).rejects.toThrow();
  });

  it('rejects tampered or truncated application messages without harming the group state', async () => {
    const s = await aliceAndBob();
    const aad = messageAad(CONV, 'c-1');
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('meet at 6'), aad);
    const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    const flip = (index: number) => {
      const copy = bytes.slice();
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      return toBase64(copy);
    };
    // One flipped bit in the header, the middle and the authentication tag; and a cut message.
    for (const forged of [
      flip(8),
      flip(Math.floor(bytes.length / 2)),
      flip(bytes.length - 1),
      toBase64(bytes.slice(0, -16)),
    ]) {
      await expect(s.bobWebGroup.decrypt(forged, aad)).rejects.toThrow();
    }
    // The failed attempts changed nothing: the genuine message still decrypts.
    const genuine = await s.bobWebGroup.decrypt(ciphertext, aad);
    expect(fromUtf8(genuine.plaintext)).toBe('meet at 6');
  });

  it('a device outside the group cannot decrypt, even with a valid key package of its own', async () => {
    const s = await aliceAndBob();
    const mallory = await makeDevice(MALLORY);
    const directory = [...s.directory, ...directoryOf(mallory)];
    // Mallory runs her own group with the same ID and tries to read Alice's ciphertext.
    const malloryGroup = await MlsGroup.create(mallory, CONV, directory);
    const aad = messageAad(CONV, 'c-1');
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('private'), aad);
    await expect(malloryGroup.decrypt(ciphertext, aad)).rejects.toThrow();
  });

  it('refuses to add a device whose key does not match the directory', async () => {
    const s = await aliceAndBob();
    const impostor = await makeDevice(BOB);
    // Directory says the device key ID belongs to a different signature key.
    const forged: LocalDevice = { ...impostor, deviceKeyId: s.bobWeb.deviceKeyId };
    const forgedKp = await keyPackage(forged);
    await expect(s.aliceGroup.commit({ add: [forgedKp.publicKey] })).rejects.toThrow(
      MlsSecurityError,
    );
  });

  it('removed devices cannot read messages from later epochs', async () => {
    const s = await aliceAndBob();
    const removal = await s.aliceGroup.commit({ removeDeviceKeyIds: [s.bobPhone.deviceKeyId] });
    const bobWeb = (await s.bobWebGroup.processCommit(removal.commit)).group;
    expect(bobWeb.members().map((m) => m.deviceKeyId)).not.toContain(s.bobPhone.deviceKeyId);

    const aad = messageAad(CONV, 'c-3');
    const { ciphertext } = await removal.group.encrypt(utf8('after removal'), aad);
    expect(fromUtf8((await bobWeb.decrypt(ciphertext, aad)).plaintext)).toBe('after removal');
    await expect(s.bobPhoneGroup.decrypt(ciphertext, aad)).rejects.toThrow();
  });

  it('a new device joins externally from the published GroupInfo and can read new messages', async () => {
    const s = await aliceAndBob();
    const aliceLaptop = await makeDevice(ALICE);
    const directory = [...s.directory, ...directoryOf(aliceLaptop)];
    const groupInfo = await s.aliceGroup.groupInfo();
    const joined = await MlsGroup.joinExternal(aliceLaptop, groupInfo, directory);

    const alice = (await s.aliceGroup.withDirectory(directory).processCommit(joined.commit)).group;
    const bob = (await s.bobWebGroup.withDirectory(directory).processCommit(joined.commit)).group;
    expect(alice.epoch).toBe(2n);
    expect(bob.members()).toHaveLength(4);

    const aad = messageAad(CONV, 'c-4');
    const { ciphertext } = await bob.encrypt(utf8('welcome, laptop'), aad);
    expect(fromUtf8((await joined.group.decrypt(ciphertext, aad)).plaintext)).toBe(
      'welcome, laptop',
    );
  });

  it('members reject an external join by a device missing from their directory', async () => {
    const s = await aliceAndBob();
    const rogue = await makeDevice(ALICE);
    // The rogue device is in its own (forged) directory, but not in Bob's.
    const joined = await MlsGroup.joinExternal(rogue, await s.aliceGroup.groupInfo(), [
      ...s.directory,
      ...directoryOf(rogue),
    ]);
    await expect(s.bobWebGroup.processCommit(joined.commit)).rejects.toThrow();
  });

  it('survives serialization and restore without losing the ability to decrypt', async () => {
    const s = await aliceAndBob();
    const restored = await MlsGroup.restore(s.bobWebGroup.serialize(), s.directory);
    const aad = messageAad(CONV, 'c-5');
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('still works'), aad);
    expect(fromUtf8((await restored.decrypt(ciphertext, aad)).plaintext)).toBe('still works');
  });

  it('decrypts messages from the previous epoch after a commit (bounded retention)', async () => {
    const s = await aliceAndBob();
    const aad = messageAad(CONV, 'c-6');
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('sent before commit'), aad);
    const removal = await s.bobWebGroup.commit({ removeDeviceKeyIds: [s.bobPhone.deviceKeyId] });
    expect((await removal.group.decrypt(ciphertext, aad)).sender.ogcId).toBe(ALICE);
  });

  it('cannot decrypt the same ciphertext twice (keys are deleted after use)', async () => {
    const s = await aliceAndBob();
    const aad = messageAad(CONV, 'c-7');
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('once'), aad);
    const first = await s.bobWebGroup.decrypt(ciphertext, aad);
    await expect(first.group.decrypt(ciphertext, aad)).rejects.toThrow();
  });
});

describe('delivery-service inspection', () => {
  it('verifies key packages and extracts the device credential', async () => {
    const device = await makeDevice(ALICE);
    const kp = await keyPackage(device);
    const inspected = await inspectKeyPackage(kp.publicKey);
    expect(inspected.device).toEqual({ ogcId: ALICE, deviceKeyId: device.deviceKeyId });
    expect(inspected.ref).toBe(kp.ref);
  });

  it('rejects tampered key packages and expired ones', async () => {
    const kp = await keyPackage(await makeDevice(ALICE));
    const bytes = Uint8Array.from(atob(kp.publicKey), (c) => c.charCodeAt(0));
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0xff;
    await expect(inspectKeyPackage(toBase64(bytes))).rejects.toThrow();
    const future = new Date(Date.now() + 400 * 24 * 3600 * 1000);
    await expect(inspectKeyPackage(kp.publicKey, future)).rejects.toThrow('expired');
  });

  it('summarises commits, group info, welcomes and application headers without secrets', async () => {
    const s = await aliceAndBob();
    const commit = await inspectCommit(s.commit.commit);
    expect(commit.epoch).toBe(0n);
    expect(commit.groupId).toBe(CONV);
    expect(commit.sender).toEqual({ type: 'member', leafIndex: 0 });
    expect(commit.proposals.filter((p) => p.type === 'add')).toHaveLength(2);

    const info = await inspectGroupInfo(s.commit.groupInfo);
    expect(info.epoch).toBe(1n);
    expect(info.members.map((m) => m.deviceKeyId).sort()).toEqual(
      [s.alice.deviceKeyId, s.bobWeb.deviceKeyId, s.bobPhone.deviceKeyId].sort(),
    );

    expect(inspectWelcome(s.commit.welcome ?? '').keyPackageRefs).toHaveLength(2);

    const aad = messageAad(CONV, 'c-8');
    const { ciphertext } = await s.aliceGroup.encrypt(utf8('header only'), aad);
    const header = inspectApplicationMessage(ciphertext);
    expect(header.epoch).toBe(1n);
    expect(fromUtf8(header.authenticatedData)).toBe(`ogc-msg/v1/${CONV}/c-8`);
  });

  it('identifies the joining device of an external commit', async () => {
    const s = await aliceAndBob();
    const laptop = await makeDevice(ALICE);
    const joined = await MlsGroup.joinExternal(laptop, await s.aliceGroup.groupInfo(), [
      ...s.directory,
      ...directoryOf(laptop),
    ]);
    const inspected = await inspectCommit(joined.commit);
    expect(inspected.sender).toEqual({
      type: 'external',
      device: { ogcId: ALICE, deviceKeyId: laptop.deviceKeyId },
    });
  });

  it('rejects the wrong message types', async () => {
    const s = await aliceAndBob();
    await expect(inspectCommit(s.commit.groupInfo)).rejects.toThrow(MlsSecurityError);
    expect(() => inspectApplicationMessage(s.commit.commit)).toThrow(MlsSecurityError);
    await expect(inspectGroupInfo('not base64!')).rejects.toThrow();
  });
});
