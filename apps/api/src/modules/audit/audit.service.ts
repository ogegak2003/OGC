import { Injectable } from '@nestjs/common';
import type { RequestMeta } from '../../common/request-meta.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuditEventType, Prisma } from '../../generated/prisma/client.js';

export interface AuditEventInput {
  type: AuditEventType;
  userId?: string | undefined;
  sessionId?: string | undefined;
  meta?: RequestMeta | undefined;
  /** Non-sensitive context only. Never pass credentials, tokens, or token hashes. */
  details?: Record<string, string | number | boolean> | undefined;
}

/**
 * Writes security events to the append-only `audit_events` table. Pass a
 * transaction client to record an event atomically with the change it describes.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventInput, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditEvent.create({
      data: {
        type: event.type,
        userId: event.userId ?? null,
        sessionId: event.sessionId ?? null,
        ipAddress: event.meta?.ipAddress ?? null,
        userAgent: event.meta?.userAgent ?? null,
        ...(event.details ? { metadata: event.details } : {}),
      },
    });
  }
}
