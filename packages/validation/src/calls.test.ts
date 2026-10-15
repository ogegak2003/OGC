import { describe, expect, it } from 'vitest';
import {
  CALL_SDP_MAX_LENGTH,
  callEndSchema,
  callHistoryQuerySchema,
  callSignalSchema,
  callStartSchema,
} from './calls.js';

const id = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f';

describe('call signaling schemas', () => {
  it('accepts a voice or video call start and nothing else', () => {
    expect(callStartSchema.safeParse({ conversationId: id, media: 'AUDIO' }).success).toBe(true);
    expect(callStartSchema.safeParse({ conversationId: id, media: 'VIDEO' }).success).toBe(true);
    expect(callStartSchema.safeParse({ conversationId: id, media: 'SCREEN' }).success).toBe(false);
    expect(callStartSchema.safeParse({ conversationId: 'nope', media: 'AUDIO' }).success).toBe(
      false,
    );
  });

  it('refuses extra fields (no forged caller or recipient identity in payloads)', () => {
    expect(
      callStartSchema.safeParse({ conversationId: id, media: 'AUDIO', callerId: id }).success,
    ).toBe(false);
    expect(callEndSchema.safeParse({ callId: id, outcome: 'COMPLETED' }).success).toBe(false);
  });

  it('bounds session descriptions and candidates', () => {
    const offer = { callId: id, signal: { type: 'offer', sdp: 'v=0' } };
    expect(callSignalSchema.safeParse(offer).success).toBe(true);
    const huge = {
      callId: id,
      signal: { type: 'offer', sdp: 'x'.repeat(CALL_SDP_MAX_LENGTH + 1) },
    };
    expect(callSignalSchema.safeParse(huge).success).toBe(false);
    expect(
      callSignalSchema.safeParse({
        callId: id,
        signal: {
          type: 'ice',
          candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      callSignalSchema.safeParse({
        callId: id,
        signal: { type: 'ice', candidate: 'x', sdpMid: '0', sdpMLineIndex: 99 },
      }).success,
    ).toBe(false);
    expect(callSignalSchema.safeParse({ callId: id, signal: { type: 'bye' } }).success).toBe(false);
  });

  it('accepts camera and microphone state updates', () => {
    expect(
      callSignalSchema.safeParse({
        callId: id,
        signal: { type: 'media', microphone: false, camera: true },
      }).success,
    ).toBe(true);
  });

  it('validates history queries', () => {
    expect(callHistoryQuerySchema.parse({ conversationId: id }).limit).toBeGreaterThan(0);
    expect(callHistoryQuerySchema.safeParse({ conversationId: 'x' }).success).toBe(false);
  });
});
