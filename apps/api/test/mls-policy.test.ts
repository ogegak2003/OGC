import {
  type DirectoryDevice,
  type LocalDevice,
  MlsGroup,
  fromBase64,
  generateKeyPackages,
  generateSigningKeyPair,
  messageAad,
  toBase64,
} from '@ogc/e2ee';
import type { ConversationView } from '@ogc/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * The MLS delivery service must hold its policy against a misbehaving or
 * malicious client that speaks valid MLS: these tests build commits and
 * messages by hand instead of using the well-behaved engine.
 */
describe('MLS delivery-service policy', () => {
  let t: TestApp;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let mallory: TestUser;
  let aliceDevice: TestDevice;
  let bobDevice: TestDevice;
  let conversation: ConversationView;

  /** A raw device: registered key, no engine — the test controls every MLS step. */
  async function rawDevice(
    user: TestUser,
  ): Promise<{ device: LocalDevice; transport: HttpTransport }> {
    const { accessToken } = await nativeTokens(t, user.email);
    const transport = new HttpTransport(baseUrl, accessToken);
    const signing = await generateSigningKeyPair();
    const { deviceKeyId } = await transport.registerDeviceKey(toBase64(signing.publicKey));
    return { device: { ogcId: user.ogcId, deviceKeyId, signing }, transport };
  }

  const directoryOf = async (transport: HttpTransport, id: string): Promise<DirectoryDevice[]> =>
    (await transport.directory(id)).map((d) => ({
      ogcId: d.ogcId,
      deviceKeyId: d.deviceKeyId,
      signaturePublicKey: fromBase64(d.signaturePublicKey),
    }));

  beforeAll(async () => {
    t = await createTestApp();
    baseUrl = await listen(t);
    [alice, bob, mallory] = await Promise.all([
      signedInUser(t, 'Alice'),
      signedInUser(t, 'Bob'),
      signedInUser(t, 'Mallory'),
    ]);
    await makeContacts(t, alice, bob);
    aliceDevice = await newDevice(t, baseUrl, alice);
    bobDevice = await newDevice(t, baseUrl, bob);
    conversation = await aliceDevice.client.openDirect(bob.ogcId);
    await aliceDevice.client.send(conversation.id, { text: 'group established' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('requires an encryption-ready device for encrypted operations', async () => {
    const { accessToken } = await nativeTokens(t, alice.email);
    const plain = new HttpTransport(baseUrl, accessToken);
    await expect(
      plain.sendMessage(conversation.id, {
        clientMessageId: crypto.randomUUID(),
        epoch: 1,
        ciphertext: 'AAAA',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'E2EE_DEVICE_REQUIRED' });
    await expect(plain.uploadKeyPackages(['AAAA'])).rejects.toMatchObject({
      code: 'E2EE_DEVICE_REQUIRED',
    });
  });

  it('manages device keys: idempotent re-registration, replacement, no key sharing between devices', async () => {
    const { device, transport } = await rawDevice(alice);
    const again = await transport.registerDeviceKey(toBase64(device.signing.publicKey));
    expect(again.deviceKeyId).toBe(device.deviceKeyId);
    const replacement = await generateSigningKeyPair();
    const replaced = await transport.registerDeviceKey(toBase64(replacement.publicKey));
    expect(replaced.deviceKeyId).not.toBe(device.deviceKeyId);
    const old = await t.prisma.deviceKey.findUniqueOrThrow({ where: { id: device.deviceKeyId } });
    expect(old.revokedAt).not.toBeNull();
    // Another device (even of another account) cannot claim an existing key.
    const { accessToken } = await nativeTokens(t, mallory.email);
    await expect(
      new HttpTransport(baseUrl, accessToken).registerDeviceKey(toBase64(replacement.publicKey)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('accepts only key packages that name this account, this device and its registered key', async () => {
    const { device, transport } = await rawDevice(alice);
    const [ok] = await generateKeyPackages(device, 1);
    await expect(transport.uploadKeyPackages([ok?.publicKey ?? ''])).resolves.toMatchObject({
      keyPackagesAvailable: 1,
    });

    const asBob = await generateKeyPackages({ ...device, ogcId: bob.ogcId }, 1);
    const otherDevice = await generateKeyPackages(
      { ...device, deviceKeyId: crypto.randomUUID() },
      1,
    );
    const otherKey = await generateKeyPackages(
      { ...device, signing: await generateSigningKeyPair() },
      1,
    );
    for (const forged of [asBob, otherDevice, otherKey]) {
      await expect(transport.uploadKeyPackages([forged[0]?.publicKey ?? ''])).rejects.toMatchObject(
        {
          status: 400,
          code: 'INVALID_MLS_MESSAGE',
        },
      );
    }
    await expect(transport.uploadKeyPackages(['AAAAAAAA'])).rejects.toMatchObject({
      code: 'INVALID_MLS_MESSAGE',
    });
  });

  it('rejects commits for the wrong epoch or group (compare-and-set)', async () => {
    const { device, transport } = await rawDevice(bob);
    const group = await aliceDevice.transport.mlsGroup(conversation.id);
    const joined = await MlsGroup.joinExternal(
      device,
      group.groupInfo ?? '',
      await directoryOf(transport, conversation.id),
    );
    await expect(
      transport.submitCommit(conversation.id, {
        epoch: group.epoch - 1,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Accepted once…
    await expect(
      transport.submitCommit(conversation.id, {
        epoch: group.epoch,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      }),
    ).resolves.toMatchObject({ epoch: group.epoch + 1 });
    // …and never twice for the same epoch.
    await expect(
      transport.submitCommit(conversation.id, {
        epoch: group.epoch,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_EPOCH' });
    // A commit for another conversation's group is refused.
    await makeContacts(t, bob, mallory);
    const other = await bobDevice.client.openDirect(mallory.ogcId);
    await expect(
      transport.submitCommit(other.id, {
        epoch: 0,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to put a non-participant’s device into the group', async () => {
    const intruder = await rawDevice(mallory);
    const [intruderKp] = await generateKeyPackages(intruder.device, 1);
    await intruder.transport.uploadKeyPackages([intruderKp?.publicKey ?? '']);
    // Alice's own client (malicious) trusts Mallory's device and tries to add it.
    const { device, transport } = await rawDevice(alice);
    const server = await transport.mlsGroup(conversation.id);
    const directory = [
      ...(await directoryOf(transport, conversation.id)),
      {
        ogcId: mallory.ogcId,
        deviceKeyId: intruder.device.deviceKeyId,
        signaturePublicKey: intruder.device.signing.publicKey,
      },
    ];
    const joined = await MlsGroup.joinExternal(device, server.groupInfo ?? '', directory);
    await transport.submitCommit(conversation.id, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    const add = await joined.group.commit({ add: [intruderKp?.publicKey ?? ''] });
    await expect(
      transport.submitCommit(conversation.id, {
        epoch: server.epoch + 1,
        commit: add.commit,
        groupInfo: add.groupInfo,
        ...(add.welcome ? { welcome: add.welcome } : {}),
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Claiming key packages of foreign devices is refused too.
    await expect(
      transport.claimKeyPackages(conversation.id, [intruder.device.deviceKeyId]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses removal of the other person’s active devices and joins on another device’s behalf', async () => {
    const { device, transport } = await rawDevice(alice);
    const server = await transport.mlsGroup(conversation.id);
    const directory = await directoryOf(transport, conversation.id);
    const joined = await MlsGroup.joinExternal(device, server.groupInfo ?? '', directory);
    // Submitting someone else's external join (here: from a different session of Alice).
    const { accessToken } = await nativeTokens(t, alice.email);
    const other = new HttpTransport(baseUrl, accessToken);
    await other.registerDeviceKey(toBase64((await generateSigningKeyPair()).publicKey));
    await expect(
      other.submitCommit(conversation.id, {
        epoch: server.epoch,
        commit: joined.commit,
        groupInfo: joined.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await transport.submitCommit(conversation.id, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    const remove = await joined.group.commit({
      removeDeviceKeyIds: [bobDevice.client.deviceKeyId ?? ''],
    });
    await expect(
      transport.submitCommit(conversation.id, {
        epoch: server.epoch + 1,
        commit: remove.commit,
        groupInfo: remove.groupInfo,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('binds application ciphertext to its conversation, epoch and message ID', async () => {
    await bobDevice.client.syncConversation(conversation.id);
    const { device, transport } = await rawDevice(alice);
    const server = await transport.mlsGroup(conversation.id);
    const joined = await MlsGroup.joinExternal(
      device,
      server.groupInfo ?? '',
      await directoryOf(transport, conversation.id),
    );
    await transport.submitCommit(conversation.id, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    const epoch = server.epoch + 1;

    const clientMessageId = crypto.randomUUID();
    const { ciphertext } = await joined.group.encrypt(
      new TextEncoder().encode('{"v":1,"text":"x"}'),
      messageAad(conversation.id, clientMessageId),
    );
    // Same ciphertext under a different message ID: the AAD does not match.
    await expect(
      transport.sendMessage(conversation.id, {
        clientMessageId: crypto.randomUUID(),
        epoch,
        ciphertext,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_MLS_MESSAGE' });
    // Wrong declared epoch.
    await expect(
      transport.sendMessage(conversation.id, { clientMessageId, epoch: epoch + 1, ciphertext }),
    ).rejects.toMatchObject({ status: 400 });
    // Correct envelope is accepted.
    await expect(
      transport.sendMessage(conversation.id, { clientMessageId, epoch, ciphertext }),
    ).resolves.toMatchObject({
      clientMessageId,
      epoch,
    });
  });

  it('rejects messages encrypted for an outdated epoch so no device is silently left out', async () => {
    const { device, transport } = await rawDevice(alice);
    const server = await transport.mlsGroup(conversation.id);
    const joined = await MlsGroup.joinExternal(
      device,
      server.groupInfo ?? '',
      await directoryOf(transport, conversation.id),
    );
    await transport.submitCommit(conversation.id, {
      epoch: server.epoch,
      commit: joined.commit,
      groupInfo: joined.groupInfo,
    });
    // Someone else moves the group forward.
    await bobDevice.client.reconcile(conversation.id);
    const late = await rawDevice(bob);
    await bobDevice.client.syncConversation(conversation.id);
    const now = await transport.mlsGroup(conversation.id);
    const lateJoin = await MlsGroup.joinExternal(
      late.device,
      now.groupInfo ?? '',
      await directoryOf(late.transport, conversation.id),
    );
    await late.transport.submitCommit(conversation.id, {
      epoch: now.epoch,
      commit: lateJoin.commit,
      groupInfo: lateJoin.groupInfo,
    });

    const clientMessageId = crypto.randomUUID();
    const { ciphertext } = await joined.group.encrypt(
      new TextEncoder().encode('{"v":1,"text":"old"}'),
      messageAad(conversation.id, clientMessageId),
    );
    await expect(
      transport.sendMessage(conversation.id, {
        clientMessageId,
        epoch: Number(joined.group.epoch),
        ciphertext,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_EPOCH' });
  });

  it('delivers Welcomes only to the device they are addressed to', async () => {
    const tablet = await newDevice(t, baseUrl, bob);
    await aliceDevice.client.reconcile(conversation.id);
    const welcome = await t.prisma.mlsWelcome.findFirstOrThrow({
      where: { deviceKeyId: tablet.client.deviceKeyId ?? '' },
    });
    expect(await bobDevice.transport.welcomes()).toEqual([]);
    expect(await aliceDevice.transport.welcomes()).toEqual([]);
    // Acknowledging someone else's Welcome does nothing.
    await bobDevice.transport.acknowledgeWelcome(welcome.id);
    expect(await t.prisma.mlsWelcome.count({ where: { id: welcome.id } })).toBe(1);
    expect((await tablet.transport.welcomes()).map((w) => w.id)).toEqual([welcome.id]);
  });
});
