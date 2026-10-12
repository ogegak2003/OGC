import { HttpStatus, Injectable } from '@nestjs/common';
import type { BlockView, OgcId, Page } from '@ogc/types';
import type { PageQuery } from '@ogc/validation';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RelationshipService } from '../relationships/relationship.service.js';

/**
 * Blocking is a relationship of its own, independent of contact state. A
 * block removes any contact and cancels pending requests in both directions,
 * and `RelationshipService` hides the blocker from the blocked user. Future
 * messaging and calls must check `RelationshipService.isBlockedEitherWay`.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relationships: RelationshipService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Idempotent. Works by OGC ID regardless of whether the target is visible to
   * the viewer, and answers identically for unknown IDs, so it cannot be used
   * to probe which accounts exist.
   */
  async block(viewerId: string, ogcId: OgcId, meta: RequestMeta): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { ogcId }, select: { id: true } });
    if (target?.id === viewerId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'You cannot block yourself',
      );
    }
    if (!target) return;

    const created = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.block.createMany({
        data: [{ blockerId: viewerId, blockedId: target.id }],
        skipDuplicates: true,
      });
      await tx.contact.deleteMany({
        where: {
          OR: [
            { ownerId: viewerId, contactId: target.id },
            { ownerId: target.id, contactId: viewerId },
          ],
        },
      });
      await tx.contactRequest.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { senderId: viewerId, recipientId: target.id },
            { senderId: target.id, recipientId: viewerId },
          ],
        },
        data: { status: 'CANCELLED', respondedAt: new Date() },
      });
      if (count === 1) {
        await this.audit.record({ type: 'USER_BLOCKED', userId: viewerId, meta }, tx);
      }
      return count === 1;
    });
    if (created)
      this.events.publish({ type: 'user.blocked', blockerId: viewerId, blockedId: target.id });
  }

  /** Idempotent. Unblocking does not restore a removed contact. */
  async unblock(viewerId: string, ogcId: OgcId, meta: RequestMeta): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { ogcId }, select: { id: true } });
    if (!target) return;
    const { count } = await this.prisma.block.deleteMany({
      where: { blockerId: viewerId, blockedId: target.id },
    });
    if (count === 1) {
      await this.audit.record({ type: 'USER_UNBLOCKED', userId: viewerId, meta });
      this.events.publish({ type: 'user.unblocked', blockerId: viewerId, blockedId: target.id });
    }
  }

  async list(viewerId: string, page: PageQuery): Promise<Page<BlockView>> {
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.block.findMany({
      where: { blockerId: viewerId, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        createdAt: true,
        blocked: {
          select: {
            ogcId: true,
            profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
          },
        },
      },
    });
    return toPage(rows, page.limit, (row) => ({
      profile: this.relationships.summary(row.blocked, false),
      blockedAt: row.createdAt.toISOString(),
    }));
  }
}
