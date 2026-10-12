import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  ContactRequestResult,
  ContactRequestView,
  ContactView,
  OgcId,
  Page,
} from '@ogc/types';
import type { PageQuery } from '@ogc/validation';
import { DomainEventBus } from '../../common/events/domain-events.js';
import { ApiException } from '../../common/errors.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { RelationshipService, notFound } from '../relationships/relationship.service.js';
import { DECLINED_REQUEST_COOLDOWN_MS } from '../relationships/social.constants.js';

const conflict = (message: string): ApiException =>
  new ApiException(HttpStatus.CONFLICT, 'CONFLICT', message);

const requestNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Contact request not found');

const SUMMARY_SELECT = {
  ogcId: true,
  profile: { select: { displayName: true, avatarKey: true, profileVisibility: true } },
} as const;

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relationships: RelationshipService,
    private readonly events: DomainEventBus,
  ) {}

  /** Sends a request, or accepts theirs if they already asked (mutual request). */
  async sendRequest(viewerId: string, ogcId: OgcId): Promise<ContactRequestResult> {
    const { target, state } = await this.relationships.resolveVisible(viewerId, ogcId);
    if (state.relationship === 'SELF') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'You cannot add yourself',
      );
    }
    if (state.blockedByViewer) throw conflict('Unblock this person before adding them');
    if (state.isContact) throw conflict('You are already contacts');
    if (state.pendingRequest?.outgoing) throw conflict('You have already sent a request');
    if (state.pendingRequest && !state.pendingRequest.outgoing) {
      await this.accept(viewerId, state.pendingRequest.id);
      return { relationship: 'CONTACT' };
    }
    if (target.contactRequestPolicy === 'NOBODY') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'CONTACT_REQUESTS_DISABLED',
        'This person is not accepting contact requests',
      );
    }
    const recentlyDeclined = await this.prisma.contactRequest.count({
      where: {
        senderId: viewerId,
        recipientId: target.userId,
        status: 'DECLINED',
        respondedAt: { gt: new Date(Date.now() - DECLINED_REQUEST_COOLDOWN_MS) },
      },
    });
    if (recentlyDeclined) throw conflict('You cannot send a request to this person right now');

    try {
      const request = await this.prisma.contactRequest.create({
        data: { senderId: viewerId, recipientId: target.userId },
        select: { id: true },
      });
      this.events.publish({
        type: 'contact.request.sent',
        requestId: request.id,
        senderId: viewerId,
        recipientId: target.userId,
      });
    } catch (error) {
      // The partial unique index allows one pending request per pair (concurrent sends).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('A request between you is already pending');
      }
      throw error;
    }
    return { relationship: 'OUTGOING_REQUEST' };
  }

  /** Accepts an incoming request: only its recipient can, and only while it is pending. */
  async accept(viewerId: string, requestId: string): Promise<void> {
    const request = await this.findPending(requestId, { recipientId: viewerId });
    if (await this.relationships.isBlockedEitherWay(request.senderId, viewerId)) {
      throw requestNotFound();
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.contactRequest.updateMany({
        where: { id: request.id, recipientId: viewerId, status: 'PENDING' },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      if (count !== 1) throw requestNotFound();
      await tx.contact.createMany({
        data: [
          { ownerId: request.senderId, contactId: viewerId },
          { ownerId: viewerId, contactId: request.senderId },
        ],
        skipDuplicates: true,
      });
    });
    this.events.publish({
      type: 'contact.request.accepted',
      requestId: request.id,
      senderId: request.senderId,
      recipientId: viewerId,
    });
  }

  async decline(viewerId: string, requestId: string): Promise<void> {
    const request = await this.findPending(requestId, { recipientId: viewerId });
    await this.close(request.id, { recipientId: viewerId }, 'DECLINED');
    this.events.publish({
      type: 'contact.request.declined',
      requestId: request.id,
      senderId: request.senderId,
      recipientId: viewerId,
    });
  }

  /** Withdraws an outgoing request: only its sender can. */
  async cancel(viewerId: string, requestId: string): Promise<void> {
    const request = await this.findPending(requestId, { senderId: viewerId });
    await this.close(request.id, { senderId: viewerId }, 'CANCELLED');
    this.events.publish({
      type: 'contact.request.cancelled',
      requestId: request.id,
      senderId: viewerId,
      recipientId: request.recipientId,
    });
  }

  /** Removes a contact from both sides. Not-a-contact gives the same 404 as an unknown ID. */
  async remove(viewerId: string, ogcId: OgcId): Promise<void> {
    const other = await this.prisma.user.findUnique({ where: { ogcId }, select: { id: true } });
    if (!other) throw notFound();
    const { count } = await this.prisma.contact.deleteMany({
      where: {
        OR: [
          { ownerId: viewerId, contactId: other.id },
          { ownerId: other.id, contactId: viewerId },
        ],
      },
    });
    if (count === 0) throw notFound();
    this.events.publish({ type: 'contact.removed', userId: viewerId, contactUserId: other.id });
  }

  async list(viewerId: string, page: PageQuery): Promise<Page<ContactView>> {
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.contact.findMany({
      where: { ownerId: viewerId, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: { id: true, createdAt: true, contact: { select: SUMMARY_SELECT } },
    });
    return toPage(rows, page.limit, (row) => ({
      // Contacts always see each other's photo.
      profile: this.relationships.summary(row.contact, true),
      since: row.createdAt.toISOString(),
    }));
  }

  async listRequests(
    viewerId: string,
    direction: 'incoming' | 'outgoing',
    page: PageQuery,
  ): Promise<Page<ContactRequestView>> {
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.contactRequest.findMany({
      where: {
        status: 'PENDING',
        ...(direction === 'incoming' ? { recipientId: viewerId } : { senderId: viewerId }),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        createdAt: true,
        sender: { select: SUMMARY_SELECT },
        recipient: { select: SUMMARY_SELECT },
      },
    });
    return toPage(rows, page.limit, (row) => ({
      id: row.id,
      // Not contacts yet: the photo follows the other person's visibility setting.
      profile: this.relationships.summary(
        direction === 'incoming' ? row.sender : row.recipient,
        'by-visibility',
      ),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Loads a pending request the viewer is a party to in the given role. Requests
   * belonging to anyone else are indistinguishable from nonexistent ones (no IDOR).
   */
  private async findPending(
    requestId: string,
    party: { recipientId: string } | { senderId: string },
  ): Promise<{ id: string; senderId: string; recipientId: string }> {
    if (!/^[0-9a-f-]{36}$/.test(requestId)) throw requestNotFound();
    const request = await this.prisma.contactRequest.findFirst({
      where: { id: requestId, status: 'PENDING', ...party },
      select: { id: true, senderId: true, recipientId: true },
    });
    if (!request) throw requestNotFound();
    return request;
  }

  private async close(
    requestId: string,
    party: { recipientId: string } | { senderId: string },
    status: 'DECLINED' | 'CANCELLED',
  ): Promise<void> {
    const { count } = await this.prisma.contactRequest.updateMany({
      where: { id: requestId, status: 'PENDING', ...party },
      data: { status, respondedAt: new Date() },
    });
    if (count !== 1) throw requestNotFound();
  }
}
