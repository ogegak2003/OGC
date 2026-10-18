import {
  type BridgeProvider,
  ProviderUnavailableError,
  WebhookRejectedError,
} from './bridge-provider.js';

/** No provider configured: Bridge reports "not configured" and never places calls. */
export class DisabledBridgeProvider implements BridgeProvider {
  readonly name = 'disabled';
  readonly live = false;
  readonly simulated = false;
  readonly codeDelivery = 'sms' as const;

  sendVerificationCode(): Promise<void> {
    return Promise.reject(new ProviderUnavailableError('No Bridge provider is configured'));
  }

  startCall(): Promise<{ providerCallId: string }> {
    return Promise.reject(new ProviderUnavailableError('No Bridge provider is configured'));
  }

  endCall(): Promise<void> {
    return Promise.resolve();
  }

  callStatus(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  parseWebhook(): never {
    throw new WebhookRejectedError('no provider configured');
  }
}
