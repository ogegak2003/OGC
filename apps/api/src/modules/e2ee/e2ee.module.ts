import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DeviceKeysService } from './device-keys.service.js';
import { E2eeController } from './e2ee.controller.js';

@Module({
  imports: [AuditModule],
  controllers: [E2eeController],
  providers: [DeviceKeysService],
  exports: [DeviceKeysService],
})
export class E2eeModule {}
