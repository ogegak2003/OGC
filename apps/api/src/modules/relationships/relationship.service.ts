import { HttpStatus, Injectable } from '@nestjs/common';
import type { OgcId, ProfileSummary, Relationship } from '@ogc/types';
import { ApiException } from '../../common/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ContactRequestPolicy, ProfileVisibility } from '../../generated/prisma/client.js';
import { avatarUrlFor } from '../profiles/avatar-url.js';

/** What the relationship layer needs to know about another account. */
export interface TargetAccount {
  userId: string;
  ogcId: OgcId;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  createdAt: Date;
  profileVisibility: ProfileVisibility;
  discoverable: boolean;
  contactRequestPolicy: ContactRequestPolicy;
}

/** The viewer's full relationship to a target, computed in one place. */
export interface RelationshipState {
  relationship: Relationship;
  /** The viewer blocked the target. */
  blockedByViewer: boolean;
  /** The target blocked the viewer. Never revealed to the viewer. */
  blockedByTarget: boolean;
  isContact: boolean;
  pendingRequest: { id: string; outgoing: boolean } | null;
}

export const notFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No OGC account found for that ID');

const TARGET_SELECT = {
  id: true,
  ogcId: true,
  createdAt: true,
  profile: {
    select: {
      displayName: true,
      bio: true,
      avatarKey: true,
      profileVisibility: true,
      discoverable: true,
      contactRequestPolicy: true,
    },
  },
} as const;

/**
 * Single source of truth for how two accounts relate: visibility, relationship
 * state, and whether interaction is allowed. Profiles, contacts, blocks — and
 * later messaging — must use this instead of re-implementing the rules.
 */
@Injectable()
export class RelationshipService {
  constructor(private readonly prisma: PrismaService) {}

  /** Loads an ACTIVE account by OGC ID, ignoring visibility rules (internal use). */
  async findActive(ogcId: OgcId): Promise<TargetAccount | undefined> {
    const user = await this.prisma.user.findFirst({
      where: { ogcId, status: 'ACTIVE' },
      select: TARGET_SELECT,
    });
    if (!user?.profile) return undefined;
    return {
      userId: user.id,
      ogcId: user.ogcId as OgcId,
      createdAt: user.createdAt,
      ...user.profile,
    };
  }

  /** Computes the relationship with three indexed queries run in parallel. */
  async stateBetween(viewerId: string, targetId: string): Promise<RelationshipState> {
    if (viewerId === targetId) {
      return {
        relationship: 'SELF',
        blockedByViewer: false,
        blockedByTarget: false,
        isContact: false,
        pendingRequest: null,
      };
    }
    const [blocks, contact, request] = await Promise.all([
      this.prisma.block.findMany({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: targetId },
            { blockerId: targetId, blockedId: viewerId },
          ],
        },
        select: { blockerId: true },
      }),
      this.prisma.contact.findUnique({
        where: { ownerId_contactId: { ownerId: viewerId, contactId: targetId } },
        select: { id: true },
      }),
      this.prisma.contactRequest.findFirst({
        where: {
          status: 'PENDING',
          OR: [
            { senderId: viewerId, recipientId: targetId },
            { senderId: targetId, recipientId: viewerId },
          ],
        },
        select: { id: true, senderId: true },
      }),
    ]);

    const blockedByViewer = blocks.some((b) => b.blockerId === viewerId);
    const blockedByTarget = blocks.some((b) => b.blockerId === targetId);
    const pendingRequest = request
      ? { id: request.id, outgoing: request.senderId === viewerId }
      : null;
    const isContact = contact !== null;

    let relationship: Relationship = 'NONE';
    if (blockedByViewer) relationship = 'BLOCKED';
    else if (isContact) relationship = 'CONTACT';
    else if (pendingRequest) {
      relationship = pendingRequest.outgoing ? 'OUTGOING_REQUEST' : 'INCOMING_REQUEST';
    }
    return { relationship, blockedByViewer, blockedByTarget, isContact, pendingRequest };
  }

  /**
   * Resolves an OGC ID the way the viewer is allowed to see it. Missing,
   * inactive, non-discoverable (to non-contacts) and "blocked the viewer"
   * accounts all produce the same 404, so lookups reveal nothing extra.
   */
  async resolveVisible(
    viewerId: string,
    ogcId: OgcId,
  ): Promise<{ target: TargetAccount; state: RelationshipState }> {
    const target = await this.findActive(ogcId);
    if (!target) throw notFound();
    const state = await this.stateBetween(viewerId, target.userId);
    if (state.blockedByTarget) throw notFound();
    if (!target.discoverable && !state.isContact && state.relationship !== 'SELF') {
      throw notFound();
    }
    return { target, state };
  }

  /** Whether the viewer may see optional profile details (bio, photo, member-since). */
  canSeeDetails(
    target: Pick<TargetAccount, 'profileVisibility'>,
    state: RelationshipState,
  ): boolean {
    if (state.relationship === 'SELF') return true;
    if (state.blockedByViewer || state.blockedByTarget) return false;
    return target.profileVisibility === 'EVERYONE' || state.isContact;
  }

  canSendContactRequest(
    target: Pick<TargetAccount, 'contactRequestPolicy'>,
    state: RelationshipState,
  ): boolean {
    return state.relationship === 'NONE' && target.contactRequestPolicy === 'EVERYONE';
  }

  /** True when either side has blocked the other. For future messaging and calls. */
  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const count = await this.prisma.block.count({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return count > 0;
  }

  /** List entry for another account: the photo is shown only where details are visible. */
  summary(
    account: {
      ogcId: string;
      profile: {
        displayName: string;
        avatarKey: string | null;
        profileVisibility: ProfileVisibility;
      } | null;
    },
    detailsVisible: boolean | 'by-visibility',
  ): ProfileSummary {
    const profile = account.profile;
    const visible =
      detailsVisible === 'by-visibility'
        ? profile?.profileVisibility === 'EVERYONE'
        : detailsVisible;
    return {
      ogcId: account.ogcId as OgcId,
      displayName: profile?.displayName ?? '',
      avatarUrl: visible ? avatarUrlFor(account.ogcId as OgcId, profile?.avatarKey ?? null) : null,
    };
  }
}
