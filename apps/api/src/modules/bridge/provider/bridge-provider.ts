import type { BridgeCallStatus } from '../../../generated/prisma/client.js';

/**
 * The boundary between OGC and an authorized voice provider. OGC code depends only on this
 * interface, so providers (and countries served by different providers) can be added without
 * touching routing, billing or the UI.
 *
 * Contract:
 * - nothing an adapter reports is trusted from a client: call state reaches OGC only through
 *   `parseWebhook`, which must authenticate the provider and reject stale or forged requests;
 * - `live` is true only for an adapter that really places calls on the telephone network;
 * - adapters never log telephone numbers, codes or credentials.
 */
export interface BridgeProvider {
  /** Stable identifier stored with each call, e.g. "simulated". */
  readonly name: string;
  /** Calls reach real telephones. */
  readonly live: boolean;
  /** Development simulator: every call and code is labelled simulated. */
  readonly simulated: boolean;
  /** How verification codes are delivered. */
  readonly codeDelivery: 'sms' | 'simulated';

  /** Sends a possession-verification code to `to` (E.164). */
  sendVerificationCode(to: string, code: string): Promise<void>;

  /**
   * Asks the provider to place a call. Resolves once the provider has accepted the request
   * (not when the phone answers). `callId` is OGC's ID, echoed in provider events.
   */
  startCall(request: ProviderCallRequest, signal: AbortSignal): Promise<{ providerCallId: string }>;

  /** Asks the provider to end a call (idempotent; ending an ended call is not an error). */
  endCall(providerCallId: string, signal: AbortSignal): Promise<void>;

  /** Current state from the provider, for reconciliation; undefined if it has no record. */
  callStatus(providerCallId: string, signal: AbortSignal): Promise<ProviderCallEvent | undefined>;

  /**
   * Authenticates a webhook (signature and timestamp) and translates it into events.
   * Throws `WebhookRejectedError` for anything unauthenticated, stale or malformed.
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    now: Date,
  ): ProviderCallEvent[];
}

/**
 * Click-to-call: the provider rings `from` (the caller's own verified phone) first, then dials
 * `to` and joins the two legs. Audio stays on the telephone network; the app only controls and
 * monitors the call.
 */
export interface ProviderCallRequest {
  callId: string;
  from: string;
  to: string;
  maxDurationSeconds: number;
}

/** A provider-reported fact about a call. */
export interface ProviderCallEvent {
  /** Unique per provider: the same event delivered twice is applied once. */
  providerEventId: string;
  providerCallId: string;
  status: BridgeCallStatus;
  occurredAt: Date;
  /** Billable duration reported by the provider (final events). */
  durationSeconds?: number;
  /** Provider charge in minor units, when reported. */
  costMinor?: number;
  currency?: string;
  /** Short machine reason for failures, e.g. "USER_BUSY". */
  reason?: string;
}

export class WebhookRejectedError extends Error {
  override readonly name = 'WebhookRejectedError';
}

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
}

/** Injection token for the configured provider. */
export const BRIDGE_PROVIDER = Symbol('BRIDGE_PROVIDER');

/** Lets an in-process provider (the simulator) deliver its signed webhooks. */
export const BRIDGE_WEBHOOK_SINK = Symbol('BRIDGE_WEBHOOK_SINK');
export interface BridgeWebhookSink {
  deliver(provider: string, rawBody: Buffer, headers: Record<string, string>): Promise<void>;
}
