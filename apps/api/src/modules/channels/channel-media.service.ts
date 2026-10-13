import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { AttachmentKind, ChannelAttachmentView } from '@ogc/types';
import { ATTACHMENT_MAX_BYTES } from '@ogc/validation';
import sharp from 'sharp';
import { ApiException } from '../../common/errors.js';
import { MetricsService } from '../../common/metrics/metrics.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { detectImageFormat, invalidMedia } from '../profiles/avatar-image.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { ChannelAccessService } from './channel-access.service.js';

/** Largest edge of a re-encoded channel image. */
const IMAGE_MAX_EDGE = 2048;
const MAX_INPUT_PIXELS = 40_000_000;
const ORPHAN_TTL_MS = 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

const mediaNotFound = (): ApiException =>
  new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Attachment not found');

/**
 * Re-encodes an uploaded image as WebP: validates it really is an image,
 * applies EXIF orientation, bounds its size and drops all metadata (EXIF,
 * GPS) and any embedded payload.
 */
export async function processChannelImage(data: Buffer): Promise<Buffer> {
  if (!detectImageFormat(data)) throw invalidMedia();
  try {
    return await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw invalidMedia('This image could not be processed');
  }
}

/**
 * Media in community channels. Unlike conversation attachments these are
 * server-readable (channels are not end-to-end encrypted): images are
 * re-encoded; other files are stored as uploaded and always served as
 * downloads (never rendered inline), so they cannot run script in the web app.
 */
@Injectable()
export class ChannelMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelMediaService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly storage: ObjectStorage,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.purgeOrphans().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Channel media cleanup failed');
      });
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async upload(
    auth: AuthContext,
    fields: { channelId: string; kind: AttachmentKind; name: string; mime: string },
    data: Buffer,
  ): Promise<ChannelAttachmentView> {
    if (!this.storage.enabled) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'MEDIA_UNAVAILABLE',
        'Attachments are not available right now',
      );
    }
    const access = await this.access.requireMember(auth.userId, fields.channelId);
    this.access.assertCanParticipate(access);
    if (data.length === 0 || data.length > ATTACHMENT_MAX_BYTES[fields.kind]) {
      this.metrics.failures.inc({ operation: 'channel_media_upload', reason: 'size' });
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'PAYLOAD_TOO_LARGE',
        'This file is too large',
      );
    }
    const image = fields.kind === 'IMAGE';
    const stored = image ? await processChannelImage(data) : data;
    const id = randomUUID();
    const storageKey = `channel-media/${id}.${image ? 'webp' : 'bin'}`;
    const mime = image ? 'image/webp' : fields.mime;
    await this.storage.put(storageKey, stored, image ? 'image/webp' : 'application/octet-stream');
    try {
      await this.prisma.channelAttachment.create({
        data: {
          id,
          channelId: fields.channelId,
          uploaderId: auth.userId,
          kind: fields.kind,
          name: fields.name,
          mime,
          size: stored.length,
          storageKey,
        },
      });
    } catch (error) {
      await this.storage.delete(storageKey);
      throw error;
    }
    return {
      id,
      kind: fields.kind,
      name: fields.name,
      mime,
      size: stored.length,
      url: `/api/v1/channel-attachments/${id}`,
    };
  }

  /** Readers of the channel (same 404 otherwise). Unattached uploads: the uploader only. */
  async download(
    viewerId: string,
    id: string,
  ): Promise<{ data: Buffer; image: boolean; name: string }> {
    const row = await this.prisma.channelAttachment.findUnique({
      where: { id },
      select: {
        channelId: true,
        uploaderId: true,
        kind: true,
        name: true,
        storageKey: true,
        post: { select: { deletedAt: true, removedAt: true } },
      },
    });
    if (!row) throw mediaNotFound();
    const access = await this.access.load(viewerId, row.channelId);
    if (!access || !this.access.canRead(access)) throw mediaNotFound();
    if (!row.post && row.uploaderId !== viewerId) throw mediaNotFound();
    if (row.post?.deletedAt) throw mediaNotFound();
    if (row.post?.removedAt && !(access.role && access.role !== 'MEMBER')) throw mediaNotFound();
    const data = await this.storage.get(row.storageKey);
    if (!data) throw mediaNotFound();
    return { data, image: row.storageKey.endsWith('.webp'), name: row.name };
  }

  /** Deletes uploads that never became part of a post. */
  async purgeOrphans(now = new Date()): Promise<number> {
    const orphans = await this.prisma.channelAttachment.findMany({
      where: { postId: null, createdAt: { lt: new Date(now.getTime() - ORPHAN_TTL_MS) } },
      select: { id: true, storageKey: true },
      take: 500,
    });
    for (const orphan of orphans) {
      await this.storage.delete(orphan.storageKey);
      await this.prisma.channelAttachment.deleteMany({ where: { id: orphan.id } });
    }
    return orphans.length;
  }
}
