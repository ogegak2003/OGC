import { Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';

/**
 * Where structured logs are written. `null` means stdout. Tests override this
 * provider to capture output and assert that no secrets are ever logged.
 */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
export type LogDestination = DestinationStream | null;

@Module({
  providers: [{ provide: LOG_DESTINATION, useValue: null }],
  exports: [LOG_DESTINATION],
})
export class LogDestinationModule {}
