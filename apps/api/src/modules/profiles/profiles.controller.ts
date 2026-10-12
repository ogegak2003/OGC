import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { OgcId, OwnProfile, PublicProfile } from '@ogc/types';
import {
  type UpdateProfileInput,
  ogcIdInputSchema,
  ogcIdSchema,
  updateProfileRequestSchema,
} from '@ogc/validation';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { AVATAR_MAX_BYTES, invalidMedia } from './avatar-image.js';
import { ProfilesService } from './profiles.service.js';
import { SOCIAL_RATE_LIMITS } from '../relationships/social.constants.js';

/** The signed-in user's own profile. */
@Controller('profile')
export class OwnProfileController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<OwnProfile> {
    return this.profiles.own(auth.userId);
  }

  @Patch()
  @Throttle({ default: SOCIAL_RATE_LIMITS.profileUpdate })
  update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateProfileRequestSchema)) body: UpdateProfileInput,
    @Req() req: Request,
  ): Promise<OwnProfile> {
    return this.profiles.update(auth.userId, body, requestMeta(req));
  }

  /** `multipart/form-data` with a single `avatar` file field. The filename is ignored. */
  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: SOCIAL_RATE_LIMITS.avatarUpload })
  @UseInterceptors(
    // No `dest`/`storage`: multer keeps the upload in memory (bounded by fileSize) — nothing touches disk.
    FileInterceptor('avatar', {
      limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 },
    }),
  )
  uploadAvatar(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<OwnProfile> {
    if (!file) throw invalidMedia('Attach an image in the "avatar" field');
    return this.profiles.setAvatar(auth.userId, file.buffer, requestMeta(req));
  }

  @Delete('avatar')
  removeAvatar(@CurrentAuth() auth: AuthContext, @Req() req: Request): Promise<OwnProfile> {
    return this.profiles.removeAvatar(auth.userId, requestMeta(req));
  }
}

/** Other accounts' public profiles, by canonical OGC ID (deep links, QR codes, lists). */
@Controller('profiles')
export class PublicProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':ogcId')
  @Throttle({ default: SOCIAL_RATE_LIMITS.profileView })
  view(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: OgcId,
  ): Promise<PublicProfile> {
    return this.profiles.view(auth.userId, ogcId);
  }

  @Get(':ogcId/avatar')
  @Throttle({ default: SOCIAL_RATE_LIMITS.avatarView })
  @Header('Content-Type', 'image/webp')
  @Header('Cache-Control', 'private, max-age=3600')
  @Header('Content-Disposition', 'inline')
  async avatar(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: OgcId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const data = await this.profiles.avatar(auth.userId, ogcId);
    res.setHeader('Content-Length', data.length);
    return new StreamableFile(data);
  }
}

/**
 * Exact OGC ID lookup — the primary way to find someone. No fuzzy or global
 * search; strict per-account rate limits make enumeration impractical.
 */
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('ogc/:ogcId')
  @Throttle({ default: SOCIAL_RATE_LIMITS.discovery })
  lookup(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdInputSchema)) ogcId: OgcId,
  ): Promise<PublicProfile> {
    return this.profiles.view(auth.userId, ogcId);
  }
}
