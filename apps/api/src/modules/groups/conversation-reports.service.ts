import { Injectable } from '@nestjs/common';
import type { ConversationReportView, OgcId, Page, ReportCategory } from '@ogc/types';
import type { PageQuery } from '@ogc/validation';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { blankToNull } from '../../common/text.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ReportStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  ConversationAccessService,
  messageNotFound,
} from '../conversations/conversation-access.service.js';

export interface ConversationReportInput {
  category: ReportCategory;
  messageId?: string | undefined;
  reportedOgcId?: OgcId | undefined;
  disclosedText?: string | undefined;
  description?: string | undefined;
}

/**
 * Reports from inside end-to-end encrypted conversations (DIRECT, groups,
 * encrypted channels). OGC cannot read messages, so a report carries only
 * what the reporter explicitly chose to disclose (`disclosedText`, shown to
 * them before sending) plus routing metadata. Nothing is decrypted or
 * collected silently (ADR-035). The audit log records that a report was made,
 * never its text.
 */
@Injectable()
export class ConversationReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly audit: AuditService,
  ) {}

  async report(
    auth: AuthContext,
    conversationId: string,
    input: ConversationReportInput,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.require(auth.userId, conversationId);
    let reportedUserId: string | null = null;
    if (input.messageId) {
      const message = await this.prisma.message.findFirst({
        where: {
          id: input.messageId,
          conversationId,
          seq: { gt: access.visibleFrom },
          OR: [{ withheld: false }, { senderId: auth.userId }],
        },
        select: { senderId: true },
      });
      if (!message) throw messageNotFound();
      reportedUserId = message.senderId;
    }
    if (input.reportedOgcId) {
      // Only current participants can be named; anyone else is simply not recorded.
      const member = access.members.find((m) => m.ogcId === input.reportedOgcId);
      reportedUserId = member?.userId ?? reportedUserId;
    }
    if (reportedUserId === auth.userId) reportedUserId = null;
    const created = await this.prisma.conversationReport.create({
      data: {
        reporterId: auth.userId,
        conversationId,
        messageId: input.messageId ?? null,
        reportedUserId,
        category: input.category,
        disclosedText: blankToNull(input.disclosedText),
        description: blankToNull(input.description),
      },
      select: { id: true },
    });
    await this.audit.record({
      type: 'CONVERSATION_REPORTED',
      userId: auth.userId,
      sessionId: auth.sessionId,
      meta,
      details: {
        reportId: created.id,
        category: input.category,
        disclosed: Boolean(input.disclosedText),
      },
    });
  }

  /** Staff queue (moderators/admins), newest first. */
  async list(status: ReportStatus, page: PageQuery): Promise<Page<ConversationReportView>> {
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.conversationReport.findMany({
      where: { status, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        category: true,
        disclosedText: true,
        description: true,
        status: true,
        createdAt: true,
        conversation: { select: { type: true } },
        reporter: { select: { ogcId: true } },
        reportedUser: { select: { ogcId: true } },
      },
    });
    return toPage(rows, page.limit, (row) => ({
      id: row.id,
      conversationId: row.conversationId,
      conversationType: row.conversation?.type ?? null,
      messageId: row.messageId,
      reporterOgcId: (row.reporter?.ogcId ?? null) as OgcId | null,
      reportedOgcId: (row.reportedUser?.ogcId ?? null) as OgcId | null,
      category: row.category,
      disclosedText: row.disclosedText,
      description: row.description,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
