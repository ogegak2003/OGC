import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/errors.js';
import type { ConversationEventType, Prisma } from '../../generated/prisma/client.js';

/**
 * Takes the next value of the conversation's change counter. The UPDATE locks
 * the conversation row until the transaction ends, so concurrent changes are
 * serialized and versions become visible in commit order — the property sync
 * relies on (ADR-025). Must run inside the caller's transaction.
 */
export async function nextVersion(
  tx: Prisma.TransactionClient,
  conversationId: string,
  options: { activity?: boolean } = {},
): Promise<{ version: bigint; mlsEpoch: bigint; mlsMemberUserIds: string[] }> {
  const now = new Date();
  return tx.conversation.update({
    where: { id: conversationId },
    data: {
      version: { increment: 1 },
      updatedAt: now,
      ...(options.activity ? { lastActivityAt: now } : {}),
    },
    select: { version: true, mlsEpoch: true, mlsMemberUserIds: true },
  });
}

/**
 * Appends a membership/settings event to the conversation timeline at the next
 * version (so it syncs in order with messages). Never carries content.
 */
export async function recordConversationEvent(
  tx: Prisma.TransactionClient,
  conversationId: string,
  event: {
    type: ConversationEventType;
    actorId?: string | null;
    subjectId?: string | null;
    detail?: Prisma.InputJsonObject;
  },
): Promise<bigint> {
  const { version } = await nextVersion(tx, conversationId);
  await tx.conversationEvent.create({
    data: {
      conversationId,
      version,
      type: event.type,
      actorId: event.actorId ?? null,
      subjectId: event.subjectId ?? null,
      ...(event.detail ? { detail: event.detail } : {}),
    },
  });
  return version;
}

/**
 * Locks the conversation row for the rest of the transaction (membership
 * changes, capacity checks). Returns false if the conversation does not exist.
 */
export async function lockConversation(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "conversations" WHERE id = ${conversationId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

export const staleEpoch = (): ApiException =>
  new ApiException(
    HttpStatus.CONFLICT,
    'STALE_EPOCH',
    'The conversation’s encryption state changed; sync and try again',
  );
