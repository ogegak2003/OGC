import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { AuditModule } from '../audit/audit.module.js';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import { BRIDGE_SETTINGS, type BridgeSettings, bridgeSettings } from './bridge.config.js';
import { BridgeAdminController, BridgeController } from './bridge.controller.js';
import { BridgeBillingService } from './bridge-billing.service.js';
import { BridgeCallsService } from './bridge-calls.service.js';
import { BridgeNumbersService } from './bridge-numbers.service.js';
import { BridgeWebhookService, BridgeWebhooksController } from './bridge-webhooks.controller.js';
import { BRIDGE_PROVIDER, type BridgeProvider } from './provider/bridge-provider.js';
import { DisabledBridgeProvider } from './provider/disabled.provider.js';
import { SimulatedBridgeProvider } from './provider/simulated.provider.js';

function createProvider(settings: BridgeSettings): BridgeProvider {
  if (!settings.enabled) return new DisabledBridgeProvider();
  switch (settings.provider) {
    case 'simulated':
      return new SimulatedBridgeProvider({
        secret: settings.webhookSecret,
        outboxDir: settings.outboxDir,
        toleranceSeconds: settings.webhookToleranceSeconds,
      });
    case 'disabled':
      return new DisabledBridgeProvider();
  }
}

/**
 * OGC Bridge: optional calls to telephone networks (docs/architecture/bridge.md). Isolated
 * from OGC-to-OGC calling; with BRIDGE_ENABLED=false only `GET /bridge` (reporting "not
 * available") and number removal respond.
 */
@Module({
  imports: [AuditModule, RelationshipsModule],
  controllers: [BridgeController, BridgeAdminController, BridgeWebhooksController],
  providers: [
    {
      provide: BRIDGE_SETTINGS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => bridgeSettings(config),
    },
    {
      provide: BRIDGE_PROVIDER,
      inject: [BRIDGE_SETTINGS],
      useFactory: (settings: BridgeSettings) => createProvider(settings),
    },
    BridgeNumbersService,
    BridgeBillingService,
    BridgeCallsService,
    BridgeWebhookService,
  ],
})
export class BridgeModule implements OnModuleInit {
  constructor(
    @Inject(BRIDGE_PROVIDER) private readonly provider: BridgeProvider,
    private readonly webhooks: BridgeWebhookService,
  ) {}

  onModuleInit(): void {
    // The simulator delivers its signed events through the same path as a real provider.
    if (this.provider instanceof SimulatedBridgeProvider) this.provider.attach(this.webhooks);
  }
}
