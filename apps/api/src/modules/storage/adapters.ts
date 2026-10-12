import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { ObjectStorage, assertValidKey } from './object-storage.js';

/** Used when no storage is configured. */
export class DisabledObjectStorage extends ObjectStorage {
  readonly enabled = false;

  put(): Promise<void> {
    return Promise.reject(new Error('Object storage is disabled'));
  }

  get(): Promise<Buffer | undefined> {
    return Promise.resolve(undefined);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Development adapter that stores objects under a local directory (rejected in
 * production by env validation). Keys are validated and resolved paths are
 * checked to stay inside the root, so no key can escape it.
 */
export class LocalDiskObjectStorage extends ObjectStorage {
  readonly enabled = true;
  private readonly root: string;

  constructor(directory: string) {
    super();
    this.root = resolve(directory);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600, flag: 'wx' });
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
