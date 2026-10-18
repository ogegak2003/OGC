import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type InspectedCommit,
  type InspectedGroupInfo,
  inspectCommit,
  inspectGroupInfo,
  inspectWelcome,
} from '@ogc/e2ee';
import type { ClaimedKeyPackage, CommitAccepted, MlsGroupView } from '@ogc/types';
import { type CommitRequest, MLS_MAX_LEAVES } from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { type ActiveDevice, DeviceKeysService, invalidMls } from '../e2ee/device-keys.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { RetryLaterException } from '../../common/errors.js';
import {
  ConversationAccessService,
  type ParticipantAccess,
} from './conversation-access.service.js';
import { nextVersion, staleEpoch } from './conversation-version.js';
import { MlsResyncLimiter } from './mls-resync-limits.js';
import { devicesPerAccount } from './messaging.constants.js';
import { bytesFromBase64, bytesToBase64 } from '../../common/bytes.js';

const forbidden = (message: string): ApiException =>
  new ApiException(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);

/**
 * The MLS Delivery Service (RFC 9420 §16, ADR-024). It orders handshake
 * messages — exactly one commit is accepted per epoch (compare-and-set) — and
 * enforces OGC's membership policy using only public MLS data:
 *
 * - every member of the resulting group must be an active device of one of
 *   the conversation's *current* participants, with its registered signature
 *   key (in groups: one of each member's newest four devices, ≤ 128 leaves);
 * - a device of someone who left or was removed may be removed by any member,
 *   and the accepted tree is recorded so new messages are refused until such
 *   devices are gone (ADR-033);
 * - the committer must be the submitting device;
 * - an external commit (a device joining by itself) removes nobody — except a resync, where a
 *   device still in the tree that lost its state removes exactly its own leaf (see checkResync);
 * - a device can only be removed if it is no longer active or belongs to the committer;
 * - added devices must use a key package that was published by them and claimed.
 *
 * The server cannot read messages, and a member device cannot be added
 * without the other members' clients verifying it against the directory.
 */
@Injectable()
export class MlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly devices: DeviceKeysService,
    private readonly realtime: RealtimePublisher,
    private readonly metrics: MetricsService,
    private readonly resyncLimiter: MlsResyncLimiter,
  ) {}

  async group(auth: AuthContext, conversationId: string): Promise<MlsGroupView> {
    await this.access.require(auth.userId, conversationId);
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { mlsEpoch: true, groupInfo: true },
    });
    if (!conversation.groupInfo)
      return { epoch: Number(conversation.mlsEpoch), groupInfo: null, members: [] };
    const groupInfo = bytesToBase64(conversation.groupInfo);
    const inspected = await inspectGroupInfo(groupInfo);
    return {
      epoch: Number(conversation.mlsEpoch),
      groupInfo,
      members: inspected.members.map((m) => m.deviceKeyId),
    };
  }

  /** Claims one key package for each requested device of this conversation's participants. */
  async claimKeyPackages(
    auth: AuthContext,
    conversationId: string,
    deviceKeyIds: string[],
  ): Promise<ClaimedKeyPackage[]> {
    await this.devices.requireActiveKey(auth);
    const access = await this.access.require(auth.userId, conversationId);
    const active = await this.eligibleDevices(access);
    const allowed = new Set(active.map((d) => d.deviceKeyId));
    const requested = [...new Set(deviceKeyIds)];
    if (requested.some((id) => !allowed.has(id))) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'deviceKeyIds: Unknown device',
      );
    }
    return this.devices.claim(requested);
  }

  async submitCommit(
    auth: AuthContext,
    conversationId: string,
    input: CommitRequest,
  ): Promise<CommitAccepted> {
    const myDeviceKeyId = await this.devices.requireActiveKey(auth);
    const access = await this.access.require(auth.userId, conversationId);

    let commit: InspectedCommit;
    let next: InspectedGroupInfo;
    try {
      commit = await inspectCommit(input.commit);
      next = await inspectGroupInfo(input.groupInfo);
    } catch {
      this.metrics.failures.inc({ operation: 'commit', reason: 'invalid' });
      throw invalidMls();
    }
    const epoch = BigInt(input.epoch);
    if (commit.groupId !== conversationId || next.groupId !== conversationId)
      throw invalidMls('Wrong group');
    if (commit.epoch !== epoch || next.epoch !== epoch + 1n) throw invalidMls('Epoch mismatch');

    const directory = new Map((await this.eligibleDevices(access)).map((d) => [d.deviceKeyId, d]));
    if (next.members.length > MLS_MAX_LEAVES) {
      throw forbidden('This group has reached its encryption device limit');
    }
    this.checkMembers(next, directory);
    if (!next.members.some((m) => m.deviceKeyId === myDeviceKeyId)) {
      throw forbidden('The committing device must be a member of the group');
    }

    const current = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { mlsEpoch: true, groupInfo: true },
    });
    if (current.mlsEpoch !== epoch) throw staleEpoch();
    const previous = current.groupInfo
      ? await inspectGroupInfo(bytesToBase64(current.groupInfo))
      : undefined;
    const resync = this.checkSender(commit, previous, next, myDeviceKeyId, directory);
    this.checkRemovals(commit, previous, directory, auth.userId);
    const added = await this.checkAdds(commit, previous, input.welcome);

    const memberUserIds = [
      ...new Set(next.members.map((m) => directory.get(m.deviceKeyId)?.userId ?? '')),
    ];
    const accepted = await this.prisma
      .$transaction(async (tx) => {
        const { version, mlsEpoch } = await nextVersion(tx, conversationId);
        if (mlsEpoch !== epoch) throw staleEpoch();
        // Membership may have changed since the checks above; the row lock makes this final.
        const participants = await tx.conversationParticipant.findMany({
          where: { conversationId },
          select: { userId: true },
        });
        const current = new Set(participants.map((p) => p.userId));
        if (!current.has(auth.userId) || memberUserIds.some((id) => !current.has(id))) {
          throw staleEpoch();
        }
        // A validated resync is admitted only within its limits (counted in this transaction, so a
        // rejected or rolled-back commit never counts); it is recorded at the time it was checked.
        const resyncAt = resync
          ? await this.resyncLimiter.admit(tx, conversationId, myDeviceKeyId)
          : undefined;
        await tx.mlsCommit.create({
          data: {
            conversationId,
            epoch,
            version,
            data: bytesFromBase64(input.commit),
            senderDeviceKeyId: myDeviceKeyId,
            ...(resyncAt ? { resync: true, createdAt: resyncAt } : {}),
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            mlsEpoch: epoch + 1n,
            groupInfo: bytesFromBase64(input.groupInfo),
            mlsMemberUserIds: memberUserIds,
          },
        });
        if (input.welcome && added.length > 0) {
          await tx.mlsWelcome.createMany({
            data: added.map((deviceKeyId) => ({
              conversationId,
              deviceKeyId,
              epoch: epoch + 1n,
              data: bytesFromBase64(input.welcome ?? ''),
            })),
            skipDuplicates: true,
          });
        }
        return { epoch: Number(epoch + 1n), version: Number(version) };
      })
      .catch((error: unknown) => {
        if (resync && error instanceof RetryLaterException) {
          this.metrics.mlsResyncs.inc({ outcome: 'limited' });
        }
        throw error;
      });
    if (resync) this.metrics.mlsResyncs.inc({ outcome: 'accepted' });

    this.realtime.toUsers(
      access.members.map((m) => m.userId),
      'mls.commit',
      {
        conversationId,
        ...accepted,
      },
    );
    const addedDeviceIds = added.flatMap((id) => {
      const device = directory.get(id);
      return device ? [device.deviceId] : [];
    });
    this.realtime.toDevices(addedDeviceIds, 'mls.welcome', { conversationId });
    return accepted;
  }

  /** Devices that may be in this conversation's MLS tree. */
  private eligibleDevices(access: ParticipantAccess): Promise<ActiveDevice[]> {
    return this.devices.activeDevices(
      access.members.map((m) => m.userId),
      devicesPerAccount(access.type),
    );
  }

  /** Every leaf of the new tree must be an active participant device with its registered key. */
  private checkMembers(next: InspectedGroupInfo, directory: Map<string, ActiveDevice>): void {
    for (const member of next.members) {
      const device = directory.get(member.deviceKeyId);
      if (
        device?.ogcId !== member.ogcId ||
        !Buffer.from(device.signaturePublicKey).equals(member.signaturePublicKey)
      ) {
        throw forbidden('Only active devices of the participants can be in this conversation');
      }
    }
  }

  private checkSender(
    commit: InspectedCommit,
    previous: InspectedGroupInfo | undefined,
    next: InspectedGroupInfo,
    myDeviceKeyId: string,
    directory: Map<string, ActiveDevice>,
  ): boolean {
    if (commit.sender.type === 'external') {
      if (!previous) throw invalidMls('The group does not exist yet');
      if (commit.sender.device.deviceKeyId !== myDeviceKeyId)
        throw forbidden('Devices can only join for themselves');
      const removes = commit.proposals.flatMap((p) => (p.type === 'remove' ? [p] : []));
      const ownLeaves = previous.members.filter((m) => m.deviceKeyId === myDeviceKeyId);
      if (ownLeaves.length === 0) {
        // A device joining for the first time: an external commit removes nobody.
        if (removes.length > 0) throw invalidMls('An external join cannot remove members');
        return false;
      }
      this.checkResync(commit, removes, ownLeaves, next, myDeviceKeyId, directory);
      return true;
    }
    // Member commit: identify the committer in the tree it was created from. For the very
    // first commit (group creation) the creator is leaf 0 of the resulting tree.
    const { leafIndex } = commit.sender;
    const tree = previous ?? next;
    const committer = tree.members.find((m) => m.leafIndex === leafIndex);
    if (committer?.deviceKeyId !== myDeviceKeyId)
      throw forbidden('Commit sender does not match this device');
    if (!previous && leafIndex !== 0) throw invalidMls('Invalid group creation');
    // A member commit must add or remove devices: one that proposes nothing, or only updates,
    // would just advance the epoch (and stall everyone's messages). OGC clients never send one.
    // Only the creator's first commit may be empty: nobody else may have a device yet.
    if (
      commit.proposals.some((p) => p.type !== 'add' && p.type !== 'remove') ||
      (previous && commit.proposals.length === 0)
    ) {
      throw invalidMls('Commits must add or remove devices');
    }
    return false;
  }

  /**
   * The one exception for a device already in the tree: a resync (RFC 9420 §12.4.3.2), after
   * it lost its group state. Checked from the parsed commit and trees and the authenticated
   * device's registered key — never from a client flag. The commit must remove exactly the
   * requesting device's own leaf (holding its registered key), propose nothing but that and the
   * external init, and leave the device in the new tree exactly once (with its registered key,
   * enforced by `checkMembers`). Anything else stays "already a member".
   */
  private checkResync(
    commit: InspectedCommit,
    removes: { leafIndex: number }[],
    ownLeaves: InspectedGroupInfo['members'],
    next: InspectedGroupInfo,
    myDeviceKeyId: string,
    directory: Map<string, ActiveDevice>,
  ): void {
    const [former] = ownLeaves;
    const [removed] = removes;
    if (
      !former ||
      ownLeaves.length !== 1 ||
      removes.length !== 1 ||
      removed?.leafIndex !== former.leafIndex ||
      commit.proposals.length !== 2 ||
      !commit.proposals.some((p) => p.type === 'external_init')
    ) {
      throw invalidMls('This device is already a member');
    }
    const registered = directory.get(myDeviceKeyId);
    if (
      registered?.ogcId !== former.ogcId ||
      !Buffer.from(registered.signaturePublicKey).equals(former.signaturePublicKey)
    ) {
      throw forbidden('The rejoining device does not match its registered key');
    }
    if (next.members.filter((m) => m.deviceKeyId === myDeviceKeyId).length !== 1) {
      throw invalidMls('The rejoining device must be in the group exactly once');
    }
  }

  private checkRemovals(
    commit: InspectedCommit,
    previous: InspectedGroupInfo | undefined,
    directory: Map<string, ActiveDevice>,
    myUserId: string,
  ): void {
    for (const proposal of commit.proposals) {
      if (proposal.type !== 'remove') continue;
      const removed = previous?.members.find((m) => m.leafIndex === proposal.leafIndex);
      if (!removed) throw invalidMls('Unknown member removed');
      const device = directory.get(removed.deviceKeyId);
      if (device && device.userId !== myUserId) {
        throw forbidden(
          'You can only remove your own devices or devices that are no longer active',
        );
      }
    }
  }

  /** Returns the device key IDs added by the commit; their key packages must have been claimed. */
  private async checkAdds(
    commit: InspectedCommit,
    previous: InspectedGroupInfo | undefined,
    welcome: string | undefined,
  ): Promise<string[]> {
    const adds = commit.proposals.flatMap((p) => (p.type === 'add' ? [p] : []));
    if (adds.length === 0) {
      if (welcome) throw invalidMls('Unexpected Welcome');
      return [];
    }
    if (!welcome) throw invalidMls('A Welcome is required when adding devices');
    let refs: string[];
    try {
      refs = inspectWelcome(welcome).keyPackageRefs;
    } catch {
      throw invalidMls('Invalid Welcome');
    }
    const addedRefs = adds.map((a) => a.keyPackageRef);
    if (refs.length !== addedRefs.length || !addedRefs.every((ref) => refs.includes(ref))) {
      throw invalidMls('Welcome does not match the added devices');
    }
    for (const add of adds) {
      if (previous?.members.some((m) => m.deviceKeyId === add.device.deviceKeyId)) {
        throw invalidMls('Device is already a member');
      }
    }
    const claimed = await this.prisma.keyPackage.findMany({
      where: { ref: { in: addedRefs }, claimedAt: { not: null } },
      select: { ref: true, deviceKeyId: true },
    });
    for (const add of adds) {
      const row = claimed.find((c) => c.ref === add.keyPackageRef);
      if (row?.deviceKeyId !== add.device.deviceKeyId) {
        throw forbidden('Devices can only be added with a key package they published');
      }
    }
    return adds.map((a) => a.device.deviceKeyId);
  }
}
