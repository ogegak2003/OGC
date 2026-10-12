import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service.js';
import { OgcIdGenerator, RANDOM_INT_SOURCE, secureRandomInt } from './ogc-id.generator.js';

@Module({
  providers: [
    { provide: RANDOM_INT_SOURCE, useValue: secureRandomInt },
    OgcIdGenerator,
    IdentityService,
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
