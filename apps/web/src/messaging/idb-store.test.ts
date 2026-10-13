import 'fake-indexeddb/auto';
import { SealedStore } from '@ogc/messaging';
import { describe, expect, it } from 'vitest';
import { IdbKeyValueStore, databaseName } from './idb-store';

describe('IndexedDB storage', () => {
  it('stores sealed values per account with a persistent, non-extractable key', async () => {
    const { store, sealer } = await IdbKeyValueStore.open('OGC482731905');
    const sealed = new SealedStore(store, sealer);
    await sealed.setJson('msgs:c:000000000000', [{ text: 'secret plans' }]);
    await sealed.setJson('msgs:c:000000000001', [{ text: 'more' }]);
    await sealed.setJson('meta:c', { cursor: 4 });
    expect((await store.keys('msgs:c:')).sort()).toEqual([
      'msgs:c:000000000000',
      'msgs:c:000000000001',
    ]);

    // Raw IndexedDB holds only ciphertext.
    const raw = await store.get('msgs:c:000000000000');
    expect(new TextDecoder().decode(raw)).not.toContain('secret');
    store.close();

    // Re-opening reuses the same key, so data stays readable on this device…
    const reopened = await IdbKeyValueStore.open('OGC482731905');
    expect(await new SealedStore(reopened.store, reopened.sealer).getJson('meta:c')).toEqual({
      cursor: 4,
    });
    reopened.store.close();

    // …and the key itself cannot be read out of the browser.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName('OGC482731905'));
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error('open failed'));
      };
    });
    const key = await new Promise<unknown>((resolve) => {
      const request = db.transaction('keys').objectStore('keys').get('sealing-key');
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
    db.close();
    expect((key as CryptoKey).extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow();
  });

  it('keeps accounts apart and destroys an account’s data on sign-out', async () => {
    const a = await IdbKeyValueStore.open('OGC111111111');
    const b = await IdbKeyValueStore.open('OGC222222222');
    await a.store.set('identity', new Uint8Array([1]));
    expect(await b.store.get('identity')).toBeUndefined();
    a.store.close();
    b.store.close();
    await IdbKeyValueStore.destroy('OGC111111111');
    const fresh = await IdbKeyValueStore.open('OGC111111111');
    expect(await fresh.store.get('identity')).toBeUndefined();
    fresh.store.close();
  });
});
