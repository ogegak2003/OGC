import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { maskPhoneNumber } from '@ogc/validation';
import { z } from 'zod';
import type { BridgeCallStatus } from '../../../generated/prisma/client.js';
import {
  type BridgeProvider,
  type BridgeWebhookSink,
  type ProviderCallEvent,
  type ProviderCallRequest,
  WebhookRejectedError,
} from './bridge-provider.js';
import { SIGNATURE_HEADER, signWebhook, verifyWebhookSignature } from './webhook-signature.js';

export interface SimulatedProviderOptions {
  secret: string;
  outboxDir: string;
  toleranceSeconds: number;
  /** Timeline of the simulated call (ms after the request). */
  ringAfterMs?: number;
  answerAfterMs?: number;
  /** The simulated callee hangs up this long after answering (capped by the max duration). */
  hangUpAfterMs?: number;
}

const eventSchema = z.strictObject({
  id: z.string().min(1).max(128),
  callId: z.string().min(1).max(128),
  status: z.enum([
    'RINGING',
    'ANSWERED',
    'COMPLETED',
    'BUSY',
    'NO_ANSWER',
    'REJECTED',
    'FAILED',
    'CANCELED',
  ]),
  occurredAt: z.iso.datetime(),
  durationSeconds: z.number().int().min(0).optional(),
  reason: z.string().max(64).optional(),
});
const bodySchema = z.strictObject({ events: z.array(eventSchema).min(1).max(20) });

interface SimulatedCall {
  answeredAt?: Date;
  ended: boolean;
  timers: NodeJS.Timeout[];
  last?: ProviderCallEvent;
}

/**
 * DEVELOPMENT ONLY — places no real call and sends no SMS. Codes are written to the local dev
 * outbox; call progress is invented on a fixed timeline and delivered as signed webhooks through
 * the same path a real provider uses. Every call it touches is stored as `simulated`, and the
 * API refuses this provider in production.
 */
export class SimulatedBridgeProvider implements BridgeProvider {
  readonly name = 'simulated';
  readonly live = false;
  readonly simulated = true;
  readonly codeDelivery = 'simulated' as const;
  private sink: BridgeWebhookSink | undefined;
  private readonly calls = new Map<string, SimulatedCall>();

  constructor(private readonly options: SimulatedProviderOptions) {}

  /** Where simulated webhooks are delivered (the Bridge webhook service). */
  attach(sink: BridgeWebhookSink): void {
    this.sink = sink;
  }

  async sendVerificationCode(to: string, code: string): Promise<void> {
    await mkdir(this.options.outboxDir, { recursive: true });
    const file = join(
      this.options.outboxDir,
      `${String(Date.now())}-bridge-code-${randomUUID()}.txt`,
    );
    // The number is masked even here; the code is the point of the file (development only).
    await writeFile(
      file,
      `SIMULATED — no SMS was sent.\nTo: ${maskPhoneNumber(to)}\nYour OGC Bridge code: ${code}\n`,
      { flag: 'wx' },
    );
  }

  startCall(request: ProviderCallRequest): Promise<{ providerCallId: string }> {
    const providerCallId = `sim_${randomUUID()}`;
    const call: SimulatedCall = { ended: false, timers: [] };
    this.calls.set(providerCallId, call);
    const ring = this.options.ringAfterMs ?? 1_500;
    const answer = this.options.answerAfterMs ?? 4_000;
    const hangUp = Math.min(
      this.options.hangUpAfterMs ?? 30_000,
      request.maxDurationSeconds * 1000,
    );
    this.schedule(call, ring, () => this.emit(providerCallId, 'RINGING'));
    this.schedule(call, answer, () => {
      call.answeredAt = new Date();
      return this.emit(providerCallId, 'ANSWERED');
    });
    this.schedule(call, answer + hangUp, () => this.finish(providerCallId, call));
    return Promise.resolve({ providerCallId });
  }

  async endCall(providerCallId: string): Promise<void> {
    const call = this.calls.get(providerCallId);
    if (!call || call.ended) return;
    for (const timer of call.timers) clearTimeout(timer);
    await this.finish(providerCallId, call);
  }

  callStatus(providerCallId: string): Promise<ProviderCallEvent | undefined> {
    return Promise.resolve(this.calls.get(providerCallId)?.last);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    now: Date,
  ): ProviderCallEvent[] {
    verifyWebhookSignature(
      this.options.secret,
      rawBody,
      headers[SIGNATURE_HEADER],
      now,
      this.options.toleranceSeconds,
    );
    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(JSON.parse(rawBody.toString('utf8')));
    } catch {
      throw new WebhookRejectedError('malformed body');
    }
    return parsed.events.map((e) => ({
      providerEventId: e.id,
      providerCallId: e.callId,
      status: e.status,
      occurredAt: new Date(e.occurredAt),
      ...(e.durationSeconds === undefined ? {} : { durationSeconds: e.durationSeconds }),
      ...(e.reason === undefined ? {} : { reason: e.reason }),
    }));
  }

  /** Ends a call: completed if it was answered, otherwise cancelled before answer. */
  private finish(providerCallId: string, call: SimulatedCall): Promise<void> {
    if (call.ended) return Promise.resolve();
    call.ended = true;
    if (!call.answeredAt) return this.emit(providerCallId, 'CANCELED');
    const seconds = Math.round((Date.now() - call.answeredAt.getTime()) / 1000);
    return this.emit(providerCallId, 'COMPLETED', seconds);
  }

  private schedule(call: SimulatedCall, ms: number, run: () => Promise<void>): void {
    const timer = setTimeout(() => {
      if (!call.ended) void run().catch(() => undefined);
    }, ms);
    timer.unref();
    call.timers.push(timer);
  }

  private async emit(
    providerCallId: string,
    status: BridgeCallStatus,
    durationSeconds?: number,
  ): Promise<void> {
    const now = new Date();
    const event = {
      id: `sim_evt_${randomUUID()}`,
      callId: providerCallId,
      status,
      occurredAt: now.toISOString(),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
    const call = this.calls.get(providerCallId);
    if (call) {
      call.last = {
        providerEventId: event.id,
        providerCallId,
        status,
        occurredAt: now,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      };
    }
    if (!this.sink) return;
    const body = Buffer.from(JSON.stringify({ events: [event] }));
    await this.sink.deliver(this.name, body, {
      [SIGNATURE_HEADER]: signWebhook(this.options.secret, body, now),
    });
  }
}
