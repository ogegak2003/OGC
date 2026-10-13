import type { Prisma } from '../../generated/prisma/client.js';
import { channelNotFound } from './channel-access.service.js';

/**
 * Takes the channel's next change version. The UPDATE locks the channel row
 * until the transaction ends, serializing changes so versions become visible
 * in commit order (the same property conversation sync relies on, ADR-025).
 */
export async function nextChannelVersion(
  tx: Prisma.TransactionClient,
  channelId: string,
  options: { post?: boolean } = {},
): Promise<bigint> {
  const now = new Date();
  const rows = await tx.channel.updateManyAndReturn({
    where: { id: channelId },
    data: { version: { increment: 1 }, ...(options.post ? { lastPostAt: now } : {}) },
    select: { version: true },
  });
  const row = rows[0];
  if (!row) throw channelNotFound();
  return row.version;
}

/** Locks the channel row (membership and counter changes). False if it does not exist. */
export async function lockChannel(
  tx: Prisma.TransactionClient,
  channelId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "channels" WHERE id = ${channelId}::uuid FOR UPDATE`;
  return rows.length === 1;
}
