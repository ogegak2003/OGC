import { HttpStatus, Injectable } from '@nestjs/common';
import type { OgcId, Page, ReportStatus, UserReportView } from '@ogc/types';
import type { PageQuery, ReportUserInput } from '@ogc/validation';
import { ApiException } from '../../common/errors.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * User reports for moderators. Reporting works regardless of visibility (people
 * must be able to report someone who blocked them) and answers identically for
 * unknown IDs and duplicate reports, so it reveals nothing about accounts.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async report(reporterId: string, input: ReportUserInput, meta: RequestMeta): Promise<void> {
    const target = await this.prisma.user.findUnique({
      where: { ogcId: input.ogcId },
      select: { id: true },
    });
    if (target?.id === reporterId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'You cannot report yourself',
      );
    }
    if (!target) return;
    try {
      const report = await this.prisma.userReport.create({
        data: {
          reporterId,
          reportedUserId: target.id,
          category: input.category,
          // An empty description is stored as no description.
          description: input.description === '' ? null : (input.description ?? null),
        },
        select: { id: true },
      });
      await this.audit.record({
        type: 'USER_REPORTED',
        userId: reporterId,
        meta,
        details: { reportId: report.id, category: input.category },
      });
    } catch (error) {
      // An open report for the same person and category already exists: nothing to add.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }

  /** Moderator view. Only reachable through `@RequireStaffRole`. */
  async list(status: ReportStatus, page: PageQuery): Promise<Page<UserReportView>> {
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.userReport.findMany({
      where: { status, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        category: true,
        description: true,
        status: true,
        createdAt: true,
        reporter: { select: { ogcId: true } },
        reportedUser: { select: { ogcId: true } },
      },
    });
    return toPage(rows, page.limit, (row) => ({
      id: row.id,
      category: row.category,
      description: row.description,
      status: row.status,
      reporterOgcId: (row.reporter?.ogcId ?? null) as OgcId | null,
      reportedOgcId: (row.reportedUser?.ogcId ?? null) as OgcId | null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
