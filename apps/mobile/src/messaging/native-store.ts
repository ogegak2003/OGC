import { type Sealer, fromBase64, rawKeySealer, toBase64 } from '@ogc/e2ee';
import type { KeyValueStore } from '@ogc/messaging';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

/** Keychain / Keystore item holding the 256-bit sealing key; never backed up or migrated. */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const keyName = (ogcId: string): string => `ogc.messaging.sealingKey.${ogcId}`;

function directoryFor(ogcId: string): Directory {
  return new Directory(Paths.document, 'ogc-messaging', ogcId);
}

/** File names are the record names, percent-encoded (keys contain `:`). */
const fileName = (key: string): string => encodeURIComponent(key);

/**
 * Mobile storage for the messaging engine: one file per record in the app's
 * private documents directory. Values arrive already sealed with a key that
 * lives only in the platform keystore (via expo-secure-store), so the files
 * alone reveal nothing.
 */
export class FileKeyValueStore implements KeyValueStore {
  private constructor(private readonly directory: Directory) {}

  static async open(ogcId: string): Promise<{ store: FileKeyValueStore; sealer: Sealer }> {
    let encoded = await SecureStore.getItemAsync(keyName(ogcId), SECURE_OPTIONS);
    if (!encoded) {
      encoded = toBase64(crypto.getRandomValues(new Uint8Array(32)));
      await SecureStore.setItemAsync(keyName(ogcId), encoded, SECURE_OPTIONS);
    }
    const directory = directoryFor(ogcId);
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    return { store: new FileKeyValueStore(directory), sealer: rawKeySealer(fromBase64(encoded)) };
  }

  /** Deletes the account's local data and its sealing key (sign-out). */
  static async destroy(ogcId: string): Promise<void> {
    const directory = directoryFor(ogcId);
    if (directory.exists) directory.delete();
    await SecureStore.deleteItemAsync(keyName(ogcId), SECURE_OPTIONS);
  }

  private file(key: string): File {
    return new File(this.directory, fileName(key));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const file = this.file(key);
    return file.exists ? new Uint8Array(await file.bytes()) : undefined;
  }

  set(key: string, value: Uint8Array): Promise<void> {
    const file = this.file(key);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    const file = this.file(key);
    if (file.exists) file.delete();
    return Promise.resolve();
  }

  keys(prefix: string): Promise<string[]> {
    const names = this.directory
      .list()
      .flatMap((entry) => (entry instanceof File ? [decodeURIComponent(entry.name)] : []));
    return Promise.resolve(names.filter((name) => name.startsWith(prefix)));
  }

  clear(): Promise<void> {
    for (const entry of this.directory.list()) entry.delete();
    return Promise.resolve();
  }
}

/** Writes bytes to a private cache file (ciphertext uploads, voice playback) and returns it. */
export function cacheFile(bytes: Uint8Array, extension: string): File {
  const file = new File(Paths.cache, `ogc-${crypto.randomUUID()}.${extension}`);
  file.create({ overwrite: true });
  file.write(bytes);
  return file;
}
