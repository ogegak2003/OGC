import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  ContactRequestResult,
  ContactRequestView,
  ContactView,
  OgcId,
  Page,
} from '@ogc/types';
import {
  type PageQuery,
  contactRequestSchema,
  ogcIdSchema,
  pageQuerySchema,
} from '@ogc/validation';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { SOCIAL_RATE_LIMITS } from '../relationships/social.constants.js';
import { ContactsService } from './contacts.service.js';

/** `/api/v1/contacts`. Every operation acts only on the signed-in user's own relationships. */
@Controller('contacts')
@Throttle({ default: SOCIAL_RATE_LIMITS.contactAction })
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<Page<ContactView>> {
    return this.contacts.list(auth.userId, page);
  }

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: SOCIAL_RATE_LIMITS.contactRequest })
  send(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(contactRequestSchema)) body: { ogcId: OgcId },
  ): Promise<ContactRequestResult> {
    return this.contacts.sendRequest(auth.userId, body.ogcId);
  }

  @Get('requests/incoming')
  incoming(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<Page<ContactRequestView>> {
    return this.contacts.listRequests(auth.userId, 'incoming', page);
  }

  @Get('requests/outgoing')
  outgoing(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pageQuerySchema)) page: PageQuery,
  ): Promise<Page<ContactRequestView>> {
    return this.contacts.listRequests(auth.userId, 'outgoing', page);
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  accept(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.contacts.accept(auth.userId, id);
  }

  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  decline(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.contacts.decline(auth.userId, id);
  }

  @Delete('requests/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.contacts.cancel(auth.userId, id);
  }

  @Delete(':ogcId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('ogcId', new ZodValidationPipe(ogcIdSchema)) ogcId: OgcId,
  ): Promise<void> {
    return this.contacts.remove(auth.userId, ogcId);
  }
}
