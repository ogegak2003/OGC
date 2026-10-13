import { type Sealer, fromUtf8, utf8 } from '@ogc/e2ee';

/**
 * Minimal persistent key–value storage provided by each platform
 * (IndexedDB on web, the file system on mobile, memory in tests).
 */
export interface KeyValueStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`. */
  keys(prefix: string): Promise<string[]>;
  /** Removes everything (sign-out). */
  clear(): Promise<void>;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, Uint8Array>();

  get(key: string): Promise<Uint8Array | undefined> {
    const value = this.data.get(key);
    return Promise.resolve(value ? value.slice() : undefined);
  }
  set(key: string, value: Uint8Array): Promise<void> {
    this.data.set(key, value.slice());
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
  keys(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.data.keys()].filter((k) => k.startsWith(prefix)));
  }
  clear(): Promise<void> {
    this.data.clear();
    return Promise.resolve();
  }
  /** Test helper: raw stored bytes (to assert nothing is stored in the clear). */
  rawValues(): Uint8Array[] {
    return [...this.data.values()];
  }
}

/**
 * Everything the engine persists goes through here and is sealed (encrypted
 * and authenticated) with the device's storage key, bound to the record name.
 * Nothing — keys, MLS state or decrypted messages — is written in the clear.
 */
export class SealedStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly sealer: Sealer,
  ) {}

  async getBytes(key: string): Promise<Uint8Array | undefined> {
    const sealed = await this.kv.get(key);
    return sealed ? this.sealer.open(sealed, key) : undefined;
  }

  async setBytes(key: string, value: Uint8Array): Promise<void> {
    await this.kv.set(key, await this.sealer.seal(value, key));
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const bytes = await this.getBytes(key);
    return bytes ? (JSON.parse(fromUtf8(bytes)) as T) : undefined;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.setBytes(key, utf8(JSON.stringify(value)));
  }

  delete(key: string): Promise<void> {
    return this.kv.delete(key);
  }

  keys(prefix: string): Promise<string[]> {
    return this.kv.keys(prefix);
  }

  clear(): Promise<void> {
    return this.kv.clear();
  }
}
