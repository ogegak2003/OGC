import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/errors.js';
import type { Prisma } from '../../generated/prisma/client.js';

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
): Promise<{ version: bigint; mlsEpoch: bigint }> {
  const now = new Date();
  return tx.conversation.update({
    where: { id: conversationId },
    data: {
      version: { increment: 1 },
      updatedAt: now,
      ...(options.activity ? { lastActivityAt: now } : {}),
    },
    select: { version: true, mlsEpoch: true },
  });
}

export const staleEpoch = (): ApiException =>
  new ApiException(
    HttpStatus.CONFLICT,
    'STALE_EPOCH',
    'The conversation’s encryption state changed; sync and try again',
  );
