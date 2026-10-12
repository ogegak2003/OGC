export type EmailKind = 'verify-email' | 'account-exists';

export interface EmailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbound email port. Implementations must never log message bodies, which
 * can contain single-use secrets such as verification links.
 */
export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}
