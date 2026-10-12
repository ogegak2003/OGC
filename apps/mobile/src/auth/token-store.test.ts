import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { secureTokenStore } from './token-store';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(() => Promise.resolve('stored')),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const options = { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' };

describe('secureTokenStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores the refresh token in platform secure storage, device-only', async () => {
    await secureTokenStore.setRefreshToken('ogc_rt_x');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('ogc.refreshToken', 'ogc_rt_x', options);
  });

  it('reads and clears with the same protection options', async () => {
    await expect(secureTokenStore.getRefreshToken()).resolves.toBe('stored');
    await secureTokenStore.clear();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('ogc.refreshToken', options);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('ogc.refreshToken', options);
  });

  it('does not depend on AsyncStorage', () => {
    const manifest = jest.requireActual<{ dependencies: Record<string, string> }>(
      '../../package.json',
    );
    expect(Object.keys(manifest.dependencies)).not.toContain(
      '@react-native-async-storage/async-storage',
    );
  });
});
