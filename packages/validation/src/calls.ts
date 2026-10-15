import { CALL_MEDIA } from '@ogc/types';
import { z } from 'zod';
import { uuidSchema } from './messaging.js';
import { pageQuerySchema } from './social.js';

/**
 * Call signaling payloads (Phase 6). Session descriptions and ICE candidates are relayed
 * between the two devices without being interpreted, so they are only bounded in size and
 * shape here (the realtime transport refuses client payloads over 16 KiB anyway).
 */

/** Longest session description relayed (an audio+video SDP is typically 3–8 KB). */
export const CALL_SDP_MAX_LENGTH = 12_000;
/** Longest ICE candidate line relayed. */
export const CALL_CANDIDATE_MAX_LENGTH = 1_024;

export const callStartSchema = z.strictObject({
  conversationId: uuidSchema,
  media: z.enum(CALL_MEDIA),
});

export const callIdSchema = z.strictObject({ callId: uuidSchema });

export const callEndSchema = z.strictObject({
  callId: uuidSchema,
  reason: z.enum(['hangup', 'failed']).optional(),
});

const sdp = z.string().min(1).max(CALL_SDP_MAX_LENGTH);

export const callSignalSchema = z.strictObject({
  callId: uuidSchema,
  signal: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('offer'), sdp }),
    z.strictObject({ type: z.literal('answer'), sdp }),
    z.strictObject({
      type: z.literal('ice'),
      // An empty candidate marks the end of candidates for that media section.
      candidate: z.string().max(CALL_CANDIDATE_MAX_LENGTH),
      sdpMid: z.string().max(64).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(63).nullable(),
    }),
    z.strictObject({ type: z.literal('media'), microphone: z.boolean(), camera: z.boolean() }),
  ]),
});

export const callSyncSchema = z.strictObject({});

/** `GET /v1/calls?conversationId=…&cursor=…&limit=…` */
export const callHistoryQuerySchema = pageQuerySchema.extend({
  conversationId: uuidSchema.optional(),
});

export type CallStartRequest = z.infer<typeof callStartSchema>;
export type CallSignalRequest = z.infer<typeof callSignalSchema>;
export type CallHistoryQuery = z.infer<typeof callHistoryQuerySchema>;
