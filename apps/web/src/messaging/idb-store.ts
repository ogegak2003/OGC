import { type Sealer, generateWebSealingKey, webCryptoSealer } from '@ogc/e2ee';
import type { KeyValueStore } from '@ogc/messaging';

const KV = 'kv';
const KEYS = 'keys';
const SEALING_KEY = 'sealing-key';

/** One database per account, so two people sharing a browser never share keys or messages. */
export function databaseName(ogcId: string): string {
  return `ogc-messaging-${ogcId}`;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function open(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(KV);
    request.result.createObjectStore(KEYS);
  };
  return promisify(request);
}

/**
 * Browser storage for the messaging engine (IndexedDB). Values arrive here
 * already sealed by `SealedStore`; the sealing key is a non-extractable
 * AES-GCM `CryptoKey` stored in the same database — script can use it but
 * never read its bytes, and it never touches localStorage.
 */
export class IdbKeyValueStore implements KeyValueStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(ogcId: string): Promise<{ store: IdbKeyValueStore; sealer: Sealer }> {
    const db = await open(databaseName(ogcId));
    const existing: unknown = await promisify(
      db.transaction(KEYS).objectStore(KEYS).get(SEALING_KEY),
    );
    let key = existing instanceof CryptoKey ? existing : undefined;
    if (!key) {
      key = await generateWebSealingKey();
      await promisify(db.transaction(KEYS, 'readwrite').objectStore(KEYS).put(key, SEALING_KEY));
    }
    return { store: new IdbKeyValueStore(db), sealer: webCryptoSealer(key) };
  }

  /** Deletes the account's database entirely (sign-out). */
  static async destroy(ogcId: string): Promise<void> {
    await promisify(indexedDB.deleteDatabase(databaseName(ogcId))).catch(() => undefined);
  }

  close(): void {
    this.db.close();
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(KV, mode).objectStore(KV);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const value: unknown = await promisify(this.store('readonly').get(key));
    return value instanceof Uint8Array ? value : undefined;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await promisify(this.store('readwrite').put(value, key));
  }

  async delete(key: string): Promise<void> {
    await promisify(this.store('readwrite').delete(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const keys = await promisify(this.store('readonly').getAllKeys(range));
    return keys.map(String);
  }

  async clear(): Promise<void> {
    await promisify(this.store('readwrite').clear());
  }
}
