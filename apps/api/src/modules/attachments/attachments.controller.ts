import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { AttachmentKind, AttachmentUploadResult } from '@ogc/types';
import {
  ATTACHMENT_CIPHERTEXT_OVERHEAD,
  ATTACHMENT_MAX_BYTES,
  attachmentUploadFieldsSchema,
  uuidSchema,
} from '@ogc/validation';
import type { Response } from 'express';
import { ApiException } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { AttachmentsService } from './attachments.service.js';

const UPLOAD_MAX_BYTES =
  Math.max(...Object.values(ATTACHMENT_MAX_BYTES)) + ATTACHMENT_CIPHERTEXT_OVERHEAD;

/** `/api/v1/attachments` — encrypted blobs only. */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * `multipart/form-data`: fields `conversationId` and `kind`, and one `file`
   * part holding the client-side encrypted bytes. The filename is ignored.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('attachmentUpload') })
  @UseInterceptors(
    // Memory storage bounded by fileSize: nothing is written to disk before validation.
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 64 },
    }),
  )
  upload(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(attachmentUploadFieldsSchema))
    fields: { conversationId: string; kind: AttachmentKind },
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<AttachmentUploadResult> {
    if (!file) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_MEDIA',
        'Attach the encrypted file in the "file" field',
      );
    }
    return this.attachments.upload(auth, fields.conversationId, fields.kind, file.buffer);
  }

  /** Ciphertext download: always an opaque binary attachment, never rendered by the browser. */
  @Get(':id')
  @Throttle({ default: throttle('sync') })
  @Header('Content-Type', 'application/octet-stream')
  @Header('Content-Disposition', 'attachment; filename="attachment.bin"')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const data = await this.attachments.download(auth, id);
    res.setHeader('Content-Length', data.length);
    return new StreamableFile(data);
  }
}
