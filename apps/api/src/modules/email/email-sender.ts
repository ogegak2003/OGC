export type EmailKind = 'verify-email' | 'account-exists' | 'password-reset' | 'password-changed';

export interface EmailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbound email port. Implementations must never log message bodies, which
 * can contain single-use secrets such as verification and reset links, nor
 * recipient addresses. `send` resolves only once the provider accepted the
 * message (or, for the dev outbox, once it is written) and rejects otherwise.
 */
export abstract class EmailSender {
  /** False when no provider is configured: nothing would actually be delivered. */
  abstract readonly available: boolean;
  abstract send(message: EmailMessage): Promise<void>;
}
