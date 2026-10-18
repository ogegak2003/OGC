import type {
  BridgeCallView,
  BridgeEligibilityView,
  BridgeNumberView,
  BridgeStatusView,
  BridgeUsageView,
  BridgeVerificationView,
} from '@ogc/types';
import { send } from './api';

/** OGC Bridge: optional calls to contacts' telephones (see docs/architecture/bridge.md). */
export const bridgeApi = {
  status: (signal?: AbortSignal) => send<BridgeStatusView>('/v1/bridge', { signal }),
  startVerification: (body: { country: string; number: string; consent: true }) =>
    send<BridgeVerificationView>('/v1/bridge/number/verification', { method: 'POST', body }),
  confirm: (body: { verificationId: string; code: string }) =>
    send<BridgeNumberView>('/v1/bridge/number/verify', { method: 'POST', body }),
  setAllowContactCalls: (allowContactCalls: boolean) =>
    send<BridgeNumberView>('/v1/bridge/number', { method: 'PATCH', body: { allowContactCalls } }),
  unlink: () => send<undefined>('/v1/bridge/number', { method: 'DELETE' }),
  eligibility: (ogcId: string, signal?: AbortSignal) =>
    send<BridgeEligibilityView>(`/v1/bridge/eligibility?ogcId=${encodeURIComponent(ogcId)}`, {
      signal,
    }),
  startCall: (ogcId: string, idempotencyKey: string) =>
    send<BridgeCallView>('/v1/bridge/calls', { method: 'POST', body: { ogcId, idempotencyKey } }),
  call: (id: string, signal?: AbortSignal) =>
    send<BridgeCallView>(`/v1/bridge/calls/${encodeURIComponent(id)}`, { signal }),
  endCall: (id: string) =>
    send<BridgeCallView>(`/v1/bridge/calls/${encodeURIComponent(id)}/end`, { method: 'POST' }),
  calls: (signal?: AbortSignal) => send<BridgeCallView[]>('/v1/bridge/calls', { signal }),
  usage: (signal?: AbortSignal) => send<BridgeUsageView>('/v1/bridge/usage', { signal }),
};
