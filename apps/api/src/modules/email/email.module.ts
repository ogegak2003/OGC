import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { EmailSender } from './email-sender.js';
import { DisabledEmailSender, OutboxEmailSender } from './senders.js';

@Module({
  providers: [
    {
      provide: EmailSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): EmailSender =>
        config.get('EMAIL_TRANSPORT', { infer: true }) === 'outbox'
          ? new OutboxEmailSender(config.get('EMAIL_OUTBOX_DIR', { infer: true }))
          : new DisabledEmailSender(),
    },
  ],
  exports: [EmailSender],
})
export class EmailModule {}
