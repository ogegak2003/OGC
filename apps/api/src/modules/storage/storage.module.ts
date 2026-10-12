import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { DisabledObjectStorage, LocalDiskObjectStorage } from './adapters.js';
import { ObjectStorage } from './object-storage.js';

@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ObjectStorage =>
        config.get('STORAGE_DRIVER', { infer: true }) === 'local'
          ? new LocalDiskObjectStorage(config.get('STORAGE_LOCAL_DIR', { infer: true }))
          : new DisabledObjectStorage(),
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
