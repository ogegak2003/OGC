import type { OgcId } from './identity.js';

/**
 * OGC Bridge: optional calls from the OGC app to ordinary telephones (PSTN) through an
 * authorized voice provider. Separate from OGC-to-OGC calls, which are unchanged.
 * Telephone numbers are never shown to other people: only their owner sees a masked form.
 */

/** Which provider the server uses. `simulated` reaches no telephone (development only). */
export type BridgeProviderName = 'disabled' | 'simulated' | (string & {});

export interface BridgeCountryView {
  /** ISO 3166-1 alpha-2, e.g. "KE". */
  code: string;
  name: string;
  /** International calling code without "+", e.g. "254". */
  callingCode: string;
}

export type BridgeNumberStatus = 'VERIFIED' | 'REVOKED';

/** The signed-in person's own linked number (never another person's). */
export interface BridgeNumberView {
  id: string;
  country: string;
  /** Masked for display, e.g. "+254 7•• •••678". The full number is never returned. */
  maskedNumber: string;
  status: BridgeNumberStatus;
  verifiedAt: string | null;
  /** The owner agreed that their contacts may call this number through OGC Bridge. */
  allowContactCalls: boolean;
}

export interface BridgeVerificationView {
  id: string;
  /** How the code was sent. `simulated`: written to the local development outbox only. */
  delivery: 'sms' | 'simulated';
  expiresAt: string;
  resendAvailableAt: string;
  attemptsRemaining: number;
}

export interface BridgeLimitsView {
  maxCallSeconds: number;
  callsPerDay: number;
  concurrentCalls: number;
}

/** Everything the Bridge screens need to decide what to show. */
export interface BridgeStatusView {
  /** The feature flag (BRIDGE_ENABLED). When false, nothing else is available. */
  enabled: boolean;
  provider: BridgeProviderName;
  /** Calls reach real telephones. False for `disabled` and `simulated`. */
  liveDialing: boolean;
  countries: BridgeCountryView[];
  number: BridgeNumberView | null;
  /** A verification in progress, if any. */
  verification: BridgeVerificationView | null;
  limits: BridgeLimitsView;
}

export type BridgeCallStatus =
  | 'REQUESTED'
  | 'RINGING'
  | 'ANSWERED'
  | 'COMPLETED'
  | 'BUSY'
  | 'NO_ANSWER'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELED';

export const BRIDGE_FINAL_STATUSES: readonly BridgeCallStatus[] = [
  'COMPLETED',
  'BUSY',
  'NO_ANSWER',
  'REJECTED',
  'FAILED',
  'CANCELED',
];

export interface BridgeChargeView {
  amountMinor: number;
  currency: string;
  /** `confirmed`: from verified provider data. `estimate`: not final. */
  state: 'estimate' | 'confirmed';
}

/** A Bridge call as its caller sees it. The callee's number is never included. */
export interface BridgeCallView {
  id: string;
  callee: { ogcId: OgcId; displayName: string };
  /** Destination country (ISO 3166-1 alpha-2). */
  country: string;
  status: BridgeCallStatus;
  /** No telephone was contacted; every state came from the development simulator. */
  simulated: boolean;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** Provider-reported billable duration, when known. */
  durationSeconds: number | null;
  /** Plain-language reason for a failed, busy or rejected call. */
  failureReason: string | null;
  charge: BridgeChargeView | null;
}

/** Why a person cannot be called through Bridge (no detail that reveals their number). */
export type BridgeIneligibleReason =
  | 'BRIDGE_DISABLED'
  | 'NOT_CONFIGURED'
  | 'NOT_A_CONTACT'
  /** Bridge rings the caller's own verified phone first, so the caller must link one. */
  | 'CALLER_NUMBER_REQUIRED'
  | 'UNAVAILABLE'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'LIMIT_REACHED';

export interface BridgeEligibilityView {
  eligible: boolean;
  reason: BridgeIneligibleReason | null;
}

export interface BridgeUsageEntryView {
  id: string;
  callId: string | null;
  kind: 'CHARGE' | 'ADJUSTMENT' | 'REFUND';
  amountMinor: number;
  currency: string;
  state: 'estimate' | 'confirmed';
  createdAt: string;
}

export interface BridgeUsageView {
  entries: BridgeUsageEntryView[];
  callsToday: number;
}
