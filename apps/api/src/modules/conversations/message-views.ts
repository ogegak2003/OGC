import type { MessageView, OgcId, ReactionType } from '@ogc/types';
import type { Prisma } from '../../generated/prisma/client.js';
import { bytesToBase64 } from '../../common/bytes.js';

/** Columns needed to render a message; ciphertext is returned as stored (base64 on the wire). */
export const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  seq: true,
  version: true,
  senderId: true,
  senderDeviceKeyId: true,
  clientMessageId: true,
  epoch: true,
  ciphertext: true,
  replyToId: true,
  forwarded: true,
  revision: true,
  editedAt: true,
  deletedAt: true,
  withheld: true,
  createdAt: true,
  sender: { select: { ogcId: true } },
  reactions: {
    select: { reaction: true, userId: true, user: { select: { ogcId: true } } },
    orderBy: { createdAt: 'asc' },
  },
  attachments: { select: { id: true, kind: true, size: true }, orderBy: { id: 'asc' } },
} as const satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/**
 * Renders a message for one viewer. Reactions by people the viewer has
 * blocked are omitted.
 */
export function toMessageView(
  row: MessageRow,
  hiddenReactors: ReadonlySet<string> = new Set(),
): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: Number(row.seq),
    version: Number(row.version),
    sender: {
      ogcId: (row.sender?.ogcId ?? null) as OgcId | null,
      deviceKeyId: row.senderDeviceKeyId,
    },
    clientMessageId: row.clientMessageId,
    epoch: Number(row.epoch),
    ciphertext: row.ciphertext ? bytesToBase64(row.ciphertext) : null,
    replyToId: row.replyToId,
    forwarded: row.forwarded,
    revision: row.revision,
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    reactions: row.reactions
      .filter((r) => !hiddenReactors.has(r.userId))
      .map((r) => ({ reaction: r.reaction as ReactionType, ogcId: r.user.ogcId as OgcId })),
    attachments: row.deletedAt
      ? []
      : row.attachments.map((a) => ({ id: a.id, kind: a.kind, size: a.size })),
  };
}

/** Messages the viewer may see: not withheld from them, not hidden by them ("delete for me"). */
export function visibleTo(userId: string): Prisma.MessageWhereInput {
  return {
    OR: [{ withheld: false }, { senderId: userId }],
    hides: { none: { userId } },
  };
}
