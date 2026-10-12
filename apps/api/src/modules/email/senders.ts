import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { type EmailMessage, EmailSender } from './email-sender.js';

/** Used when no provider is configured: nothing is sent and no content is logged. */
export class DisabledEmailSender extends EmailSender {
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
