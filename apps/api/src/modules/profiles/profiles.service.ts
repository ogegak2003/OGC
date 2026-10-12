import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { OgcId, OwnProfile, PublicProfile } from '@ogc/types';
import type { UpdateProfileInput } from '@ogc/validation';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { RelationshipService, notFound } from '../relationships/relationship.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { processAvatar } from './avatar-image.js';
import { avatarUrlFor } from './avatar-url.js';

type ProfileRow = Prisma.ProfileGetPayload<{
  include: { user: { select: { ogcId: true; createdAt: true } } };
}>;

function toOwnProfile(row: ProfileRow): OwnProfile {
  const ogcId = row.user.ogcId as OgcId;
  return {
    ogcId,
    displayName: row.displayName,
    bio: row.bio,
    avatarUrl: avatarUrlFor(ogcId, row.avatarKey),
    memberSince: row.user.createdAt.toISOString(),
    privacy: {
      profileVisibility: row.profileVisibility,
      discoverable: row.discoverable,
      contactRequests: row.contactRequestPolicy,
    },
  };
}

const mediaUnavailable = (): ApiException =>
  new ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    'MEDIA_UNAVAILABLE',
    'Profile photos are not available right now',
  );

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly relationships: RelationshipService,
    private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  private load(userId: string): Promise<ProfileRow> {
    return this.prisma.profile.findUniqueOrThrow({
      where: { userId },
      include: { user: { select: { ogcId: true, createdAt: true } } },
    });
  }

  async own(userId: string): Promise<OwnProfile> {
    return toOwnProfile(await this.load(userId));
  }

  /** Applies a validated PATCH. Ownership comes from the session, never the request. */
  async update(userId: string, input: UpdateProfileInput, meta: RequestMeta): Promise<OwnProfile> {
    const data: Prisma.ProfileUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.bio !== undefined)
      data.bio = input.bio === null || input.bio === '' ? null : input.bio;
    if (input.privacy?.profileVisibility) data.profileVisibility = input.privacy.profileVisibility;
    if (input.privacy?.discoverable !== undefined) data.discoverable = input.privacy.discoverable;
    if (input.privacy?.contactRequests) data.contactRequestPolicy = input.privacy.contactRequests;

    const fields = Object.keys(data);
    await this.prisma.$transaction(async (tx) => {
      await tx.profile.update({ where: { userId }, data });
      const profileFields = fields.filter((f) => f === 'displayName' || f === 'bio');
      if (profileFields.length) {
        await this.audit.record(
          { type: 'PROFILE_UPDATED', userId, meta, details: { fields: profileFields.join(',') } },
          tx,
        );
      }
      if (input.privacy) {
        await this.audit.record(
          {
            type: 'PRIVACY_SETTINGS_CHANGED',
            userId,
            meta,
            details: Object.fromEntries(
              Object.entries(input.privacy).filter(([, v]) => v !== undefined),
            ) as Record<string, string | boolean>,
          },
          tx,
        );
      }
    });
    this.events.publish({ type: 'profile.updated', userId, fields });
    return this.own(userId);
  }

  /** Replaces the profile photo with a processed copy stored under a fresh server-generated key. */
  async setAvatar(userId: string, upload: Buffer, meta: RequestMeta): Promise<OwnProfile> {
    if (!this.storage.enabled) throw mediaUnavailable();
    const processed = await processAvatar(upload);
    const key = `avatars/${randomUUID()}.webp`;
    await this.storage.put(key, processed, 'image/webp');

    let previous: string | null;
    try {
      previous = await this.prisma.$transaction(async (tx) => {
        const current = await tx.profile.findUniqueOrThrow({
          where: { userId },
          select: { avatarKey: true },
        });
        await tx.profile.update({ where: { userId }, data: { avatarKey: key } });
        await this.audit.record(
          { type: 'PROFILE_UPDATED', userId, meta, details: { fields: 'avatar' } },
          tx,
        );
        return current.avatarKey;
      });
    } catch (error) {
      await this.storage.delete(key);
      throw error;
    }
    await this.removeObject(previous);
    this.events.publish({ type: 'profile.updated', userId, fields: ['avatar'] });
    return this.own(userId);
  }

  async removeAvatar(userId: string, meta: RequestMeta): Promise<OwnProfile> {
    const current = await this.prisma.profile.findUniqueOrThrow({
      where: { userId },
      select: { avatarKey: true },
    });
    if (current.avatarKey) {
      await this.prisma.$transaction(async (tx) => {
        await tx.profile.update({ where: { userId }, data: { avatarKey: null } });
        await this.audit.record(
          { type: 'PROFILE_UPDATED', userId, meta, details: { fields: 'avatar' } },
          tx,
        );
      });
      await this.removeObject(current.avatarKey);
      this.events.publish({ type: 'profile.updated', userId, fields: ['avatar'] });
    }
    return this.own(userId);
  }

  /** Old objects are removed after the database stops referencing them; failures only leave an orphan. */
  private async removeObject(key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not delete replaced profile photo');
    }
  }

  /** Another account as the viewer may see it (or the viewer's own public view). */
  async view(viewerId: string, ogcId: OgcId): Promise<PublicProfile> {
    const { target, state } = await this.relationships.resolveVisible(viewerId, ogcId);
    const details = this.relationships.canSeeDetails(target, state);
    return {
      ogcId: target.ogcId,
      displayName: target.displayName,
      bio: details ? target.bio : null,
      avatarUrl: details ? avatarUrlFor(target.ogcId, target.avatarKey) : null,
      memberSince: details ? target.createdAt.toISOString() : null,
      relationship: state.relationship,
      canSendContactRequest: this.relationships.canSendContactRequest(target, state),
      pendingRequestId: state.pendingRequest?.id ?? null,
    };
  }

  /** Returns the photo bytes if, and only if, the viewer may see the profile's details. */
  async avatar(viewerId: string, ogcId: OgcId): Promise<Buffer> {
    const { target, state } = await this.relationships.resolveVisible(viewerId, ogcId);
    if (!target.avatarKey || !this.relationships.canSeeDetails(target, state)) throw notFound();
    const data = await this.storage.get(target.avatarKey);
    if (!data) throw notFound();
    return data;
  }
}
