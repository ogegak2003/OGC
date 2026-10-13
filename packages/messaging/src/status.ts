import type { ConversationView, MessageStatus } from '@ogc/types';
import type { LocalMessage } from './payload.js';

export type MessageDisplayStatus = MessageStatus | 'FAILED';

/**
 * Delivery state of one of the viewer's own messages, derived from the
 * peer's delivered/read high-water marks (no per-message receipt rows).
 *
 * PENDING → stored on this device only; SENT → persisted by the server;
 * DELIVERED → stored by one of the recipient's devices; READ → seen.
 */
export function messageStatus(
  message: LocalMessage,
  conversation: Pick<ConversationView, 'peerLastDeliveredSeq' | 'peerLastReadSeq'> | undefined,
): MessageDisplayStatus | undefined {
  if (!message.mine) return undefined;
  if (message.state === 'failed') return 'FAILED';
  if (message.state === 'pending' || message.seq === null) return 'PENDING';
  if (!conversation) return 'SENT';
  if (conversation.peerLastReadSeq >= message.seq) return 'READ';
  if (conversation.peerLastDeliveredSeq >= message.seq) return 'DELIVERED';
  return 'SENT';
}
