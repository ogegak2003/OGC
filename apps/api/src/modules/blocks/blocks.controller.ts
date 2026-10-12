import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { BlockView, OgcId, Page } from '@ogc/types';
import { type PageQuery, ogcIdSchema, pageQuerySchema } from '@ogc/validation';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { SOCIAL_RATE_LIMITS } from '../relationships/social.constants.js';
import { BlocksService } from './blocks.service.js';

@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<Page<BlockView>> {
    return this.blocks.list(auth.userId, page);
  }

  @Post(':ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: SOCIAL_RATE_LIMITS.block })
  block(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: OgcId,
    @Req() req: Request,
  ): Promise<void> {
    return this.blocks.block(auth.userId, ogcId, requestMeta(req));
  }

  @Delete(':ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: SOCIAL_RATE_LIMITS.block })
  unblock(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: OgcId,
    @Req() req: Request,
  ): Promise<void> {
    return this.blocks.unblock(auth.userId, ogcId, requestMeta(req));
  }
}
