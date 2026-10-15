import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { EmailSender } from './email-sender.js';
import { DisabledEmailSender, OutboxEmailSender, SmtpEmailSender } from './senders.js';

export function createEmailSender(config: ConfigService<Env, true>): EmailSender {
  const transport = config.get('EMAIL_TRANSPORT', { infer: true });
  if (transport === 'outbox') {
    return new OutboxEmailSender(config.get('EMAIL_OUTBOX_DIR', { infer: true }));
  }
  if (transport === 'smtp') {
    // Presence is guaranteed by env validation.
    return new SmtpEmailSender({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      security: config.get('SMTP_SECURITY', { infer: true }),
      user: config.get('SMTP_USER', { infer: true }),
      password: config.get('SMTP_PASSWORD', { infer: true }),
      from: config.get('EMAIL_FROM', { infer: true }),
      timeoutMs: config.get('SMTP_TIMEOUT_MS', { infer: true }),
    });
  }
  return new DisabledEmailSender();
}

@Module({
  providers: [{ provide: EmailSender, inject: [ConfigService], useFactory: createEmailSender }],
  exports: [EmailSender],
})
export class EmailModule {}
