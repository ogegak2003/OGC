import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { type Transporter, createTransport } from 'nodemailer';
import { type EmailMessage, EmailSender } from './email-sender.js';

/** Used when no provider is configured: nothing is sent and no content is logged. */
export class DisabledEmailSender extends EmailSender {
  readonly available = false;
  private readonly logger = new Logger('Email');

  send(message: EmailMessage): Promise<void> {
    this.logger.warn({ kind: message.kind }, 'Email delivery is disabled; message not sent');
    return Promise.resolve();
  }
}

/**
 * Development only (rejected in production by env validation): writes each
 * message to a file readable only by the current user, instead of logging it.
 */
export class OutboxEmailSender extends EmailSender {
  readonly available = true;
  private readonly logger = new Logger('Email');
  private readonly directory: string;

  constructor(directory: string) {
    super();
    this.directory = resolve(directory);
  }

  async send(message: EmailMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${Date.now()}-${message.kind}-${randomUUID()}.txt`);
    const content = `To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`;
    await writeFile(file, content, { mode: 0o600, flag: 'wx' });
    this.logger.log({ kind: message.kind, outbox: this.directory }, 'Email written to dev outbox');
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** `starttls`: upgrade required (no plaintext fallback); `tls`: implicit TLS; `none`: local only. */
  security: 'starttls' | 'tls' | 'none';
  user?: string | undefined;
  password?: string | undefined;
  from: string;
  timeoutMs: number;
}

/**
 * Any SMTP provider (Amazon SES, Postmark, SendGrid, Mailgun, a company relay…). TLS 1.2+ with
 * certificate verification; nodemailer's own logging is off so neither addresses nor bodies
 * reach the logs. Failures reject with a generic error (the provider's reply is not logged
 * either: it can echo the recipient).
 */
export class SmtpEmailSender extends EmailSender {
  readonly available = true;
  private readonly logger = new Logger('Email');
  private readonly transport: Transporter;

  constructor(private readonly options: SmtpOptions) {
    super();
    this.transport = createTransport({
      host: options.host,
      port: options.port,
      secure: options.security === 'tls',
      requireTLS: options.security === 'starttls',
      ignoreTLS: options.security === 'none',
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false,
      debug: false,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        // Auto-generated: no auto-replies, no tracking.
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      this.logger.log({ kind: message.kind }, 'Email accepted by the SMTP provider');
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown';
      this.logger.warn({ kind: message.kind, code }, 'SMTP delivery failed');
      // The provider error is deliberately dropped: its text can echo the recipient address.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Email delivery failed (${code})`);
    }
  }

  close(): void {
    this.transport.close();
  }
}
