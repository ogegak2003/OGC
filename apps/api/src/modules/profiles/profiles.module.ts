import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RelationshipsModule } from '../relationships/relationships.module.js';
import {
  DiscoveryController,
  OwnProfileController,
  PublicProfilesController,
} from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

@Module({
  imports: [AuditModule, RelationshipsModule],
  controllers: [OwnProfileController, PublicProfilesController, DiscoveryController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
