import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  ClaimedKeyPackage,
  CommitAccepted,
  ConversationChanges,
  ConversationView,
  DirectoryDevice,
  MessagePage,
  MessageView,
  MlsGroupView,
  OgcId,
  Page,
  ReactionType,
  SyncPage,
} from '@ogc/types';
import {
  type CommitRequest,
  type PageQuery,
  claimKeyPackagesRequestSchema,
  commitRequestSchema,
  conversationChangesQuerySchema,
  createConversationRequestSchema,
  deleteMessageQuerySchema,
  editMessageRequestSchema,
  historyQuerySchema,
  reactionTypeSchema,
  receiptRequestSchema,
  sendMessageRequestSchema,
  syncQuerySchema,
  uuidSchema,
} from '@ogc/validation';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ConversationsService } from './conversations.service.js';
import { type SendMessageInput, MessagesService } from './messages.service.js';
import { MlsService } from './mls.service.js';

const idParam = new ZodValidationPipe(uuidSchema);
const listQuerySchema = z.strictObject({
  cursor: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** `/api/v1/conversations` — every route requires the caller to be a participant. */
@Controller('conversations')
@Throttle({ default: throttle('sync') })
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly mls: MlsService,
  ) {}

  /** Opens (or creates) the DIRECT conversation with a contact. 201 when created, 200 when it existed. */
  @Post()
  @Throttle({ default: throttle('conversationCreate') })
  async open(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createConversationRequestSchema)) body: { ogcId: OgcId },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConversationView> {
    const { conversation, created } = await this.conversations.openDirect(
      auth.userId,
      body.ogcId,
      requestMeta(req),
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return conversation;
  }

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: PageQuery,
  ): Promise<Page<ConversationView>> {
    return this.conversations.list(auth.userId, query.cursor, query.limit);
  }

  @Get('changes')
  changes(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(conversationChangesQuerySchema))
    query: { since?: string; limit: number },
  ): Promise<ConversationChanges> {
    return this.conversations.changes(auth.userId, query.since, query.limit);
  }

  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<ConversationView> {
    return this.conversations.view(auth.userId, id);
  }

  @Get(':id/devices')
  devices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
  ): Promise<DirectoryDevice[]> {
    return this.conversations.directory(auth.userId, id);
  }

  @Get(':id/messages')
  history(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(historyQuerySchema))
    query: { before?: number; after?: number; limit: number },
  ): Promise<MessagePage> {
    return this.messages.history(auth, id, query);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('messageSend') })
  send(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(sendMessageRequestSchema)) body: SendMessageInput,
  ): Promise<MessageView> {
    return this.messages.send(auth, id, body);
  }

  @Get(':id/sync')
  sync(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(syncQuerySchema)) query: { after: number; limit: number },
  ): Promise<SyncPage> {
    return this.messages.sync(auth, id, query.after, query.limit);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('receipt') })
  read(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(receiptRequestSchema)) body: { seq: number },
  ): Promise<void> {
    return this.messages.markRead(auth, id, body.seq);
  }

  @Post(':id/delivered')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('receipt') })
  delivered(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(receiptRequestSchema)) body: { seq: number },
  ): Promise<void> {
    return this.messages.markDelivered(auth, id, body.seq);
  }

  @Get(':id/mls')
  @Throttle({ default: throttle('e2ee') })
  group(@CurrentAuth() auth: AuthContext, @Param('id', idParam) id: string): Promise<MlsGroupView> {
    return this.mls.group(auth, id);
  }

  @Post(':id/mls/key-packages')
  @Throttle({ default: throttle('e2ee') })
  claim(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(claimKeyPackagesRequestSchema)) body: { deviceKeyIds: string[] },
  ): Promise<ClaimedKeyPackage[]> {
    return this.mls.claimKeyPackages(auth, id, body.deviceKeyIds);
  }

  @Post(':id/mls/commits')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: throttle('e2ee') })
  commit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(commitRequestSchema)) body: CommitRequest,
  ): Promise<CommitAccepted> {
    return this.mls.submitCommit(auth, id, body);
  }
}

/** `/api/v1/messages/:id` — edit, delete and react; authorization follows the conversation. */
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Patch(':id')
  @Throttle({ default: throttle('edit') })
  edit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(editMessageRequestSchema))
    body: { epoch: number; ciphertext: string },
  ): Promise<MessageView> {
    return this.messages.edit(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('delete') })
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(deleteMessageQuerySchema)) query: { scope: 'everyone' | 'self' },
    @Req() req: Request,
  ): Promise<void> {
    if (query.scope === 'everyone')
      await this.messages.deleteForEveryone(auth, id, requestMeta(req));
    else await this.messages.hide(auth, id);
  }

  @Put(':id/reactions/:reaction')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('reaction') })
  react(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('reaction', new ZodValidationPipe(reactionTypeSchema)) reaction: ReactionType,
  ): Promise<void> {
    return this.messages.react(auth, id, reaction, true);
  }

  @Delete(':id/reactions/:reaction')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: throttle('reaction') })
  unreact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', idParam) id: string,
    @Param('reaction', new ZodValidationPipe(reactionTypeSchema)) reaction: ReactionType,
  ): Promise<void> {
    return this.messages.react(auth, id, reaction, false);
  }
}
