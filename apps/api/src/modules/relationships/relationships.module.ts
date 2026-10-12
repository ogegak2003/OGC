import { Module } from '@nestjs/common';
import { RelationshipService } from './relationship.service.js';

@Module({
  providers: [RelationshipService],
  exports: [RelationshipService],
})
export class RelationshipsModule {}
