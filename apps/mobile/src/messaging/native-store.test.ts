import { describe, expect, it, jest } from '@jest/globals';
import { SealedStore } from '@ogc/messaging';
import * as SecureStore from 'expo-secure-store';
import { FileKeyValueStore } from './native-store';

// An in-memory keystore double that, unlike the default mock, keeps values.
jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: (key: string) => Promise.resolve(values.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
});

describe('FileKeyValueStore', () => {
  it('stores sealed records as files with the key kept in secure storage', async () => {
    const { store, sealer } = await FileKeyValueStore.open('OGC482731905');
    const sealed = new SealedStore(store, sealer);
    await sealed.setJson('msgs:conv:000000000001', [{ text: 'private' }]);
    await sealed.setJson('meta:conv', { cursor: 7 });
    expect(await store.keys('msgs:')).toEqual(['msgs:conv:000000000001']);
    const raw = await store.get('msgs:conv:000000000001');
    expect(new TextDecoder().decode(raw)).not.toContain('private');

    // A second open uses the same key from secure storage, so data stays readable.
    const again = await FileKeyValueStore.open('OGC482731905');
    expect(await new SealedStore(again.store, again.sealer).getJson('meta:conv')).toEqual({
      cursor: 7,
    });
    expect(await SecureStore.getItemAsync('ogc.messaging.sealingKey.OGC482731905')).toBeTruthy();
  });

  it('destroys the data and the key on sign-out', async () => {
    const { store } = await FileKeyValueStore.open('OGC111222333');
    await store.set('identity', new Uint8Array([1, 2, 3]));
    await FileKeyValueStore.destroy('OGC111222333');
    expect(await SecureStore.getItemAsync('ogc.messaging.sealingKey.OGC111222333')).toBeNull();
    const reopened = await FileKeyValueStore.open('OGC111222333');
    expect(await reopened.store.get('identity')).toBeUndefined();
  });
});
