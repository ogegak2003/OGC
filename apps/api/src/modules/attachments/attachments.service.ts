import { createHash, randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { AttachmentKind, AttachmentUploadResult } from '@ogc/types';
import { ATTACHMENT_CIPHERTEXT_OVERHEAD, ATTACHMENT_MAX_BYTES } from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';
import { ObjectStorage } from '../storage/object-storage.js';

/** Uploaded attachments not attached to a message within this time are deleted. */
export const ORPHAN_ATTACHMENT_TTL_MS = 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;
/** Smallest possible ciphertext: the 16-byte authentication tag plus at least one byte. */
const MIN_CIPHERTEXT_BYTES = ATTACHMENT_CIPHERTEXT_OVERHEAD + 1;

const attachmentNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Attachment not found');

/**
 * Encrypted attachments (ADR-027). Clients encrypt files before upload; the
 * server stores opaque ciphertext under a server-generated key, enforces size
 * limits per declared kind, and serves the bytes only to participants of the
 * conversation — and, before the message is sent, only to the uploader.
 * Content-type sniffing is impossible on ciphertext by design; receiving
 * clients validate the decrypted bytes instead.
 */
@Injectable()
export class AttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly storage: ObjectStorage,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.purgeOrphans().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Orphan attachment cleanup failed');
      });
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async upload(
    auth: AuthContext,
    conversationId: string,
    kind: AttachmentKind,
    ciphertext: Buffer,
  ): Promise<AttachmentUploadResult> {
    if (!this.storage.enabled) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'MEDIA_UNAVAILABLE',
        'Attachments are not available right now',
      );
    }
    const access = await this.access.require(auth.userId, conversationId);
    this.access.assertCanSend(access);
    const max = ATTACHMENT_MAX_BYTES[kind] + ATTACHMENT_CIPHERTEXT_OVERHEAD;
    if (ciphertext.length < MIN_CIPHERTEXT_BYTES || ciphertext.length > max) {
      this.metrics.failures.inc({ operation: 'attachment_upload', reason: 'size' });
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'PAYLOAD_TOO_LARGE',
        'This file is too large',
      );
    }
    const id = randomUUID();
    const storageKey = `attachments/${id}.bin`;
    try {
      await this.storage.put(storageKey, ciphertext, 'application/octet-stream');
    } catch (error) {
      this.metrics.failures.inc({ operation: 'attachment_upload', reason: 'storage' });
      throw error;
    }
    await this.prisma.attachment.create({
      data: {
        id,
        conversationId,
        uploaderId: auth.userId,
        kind,
        size: ciphertext.length,
        sha256: createHash('sha256').update(ciphertext).digest(),
        storageKey,
      },
    });
    return { id, size: ciphertext.length };
  }

  /** Returns the ciphertext if the caller may read it; otherwise the same 404 as for an unknown ID. */
  async download(auth: AuthContext, id: string): Promise<Buffer> {
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id,
        conversation: { participants: { some: { userId: auth.userId } } },
        OR: [
          { messageId: null, uploaderId: auth.userId },
          {
            message: {
              deletedAt: null,
              OR: [{ withheld: false }, { senderId: auth.userId }],
              hides: { none: { userId: auth.userId } },
            },
          },
        ],
      },
      select: { storageKey: true },
    });
    if (!attachment) throw attachmentNotFound();
    const data = await this.storage.get(attachment.storageKey);
    if (!data) throw attachmentNotFound();
    return data;
  }

  /** Deletes uploads that never became part of a message. */
  async purgeOrphans(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_ATTACHMENT_TTL_MS);
    const orphans = await this.prisma.attachment.findMany({
      where: { messageId: null, createdAt: { lt: cutoff } },
      select: { id: true, storageKey: true },
      take: 500,
    });
    for (const orphan of orphans) {
      await this.storage.delete(orphan.storageKey);
      await this.prisma.attachment.deleteMany({ where: { id: orphan.id, messageId: null } });
    }
    return orphans.length;
  }
}
