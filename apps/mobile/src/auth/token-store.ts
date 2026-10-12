import * as SecureStore from 'expo-secure-store';

/**
 * Persistent storage for the long-lived refresh token.
 *
 * Only the refresh token is persisted, and only in platform secure storage
 * (iOS Keychain / Android Keystore-backed storage) — never AsyncStorage. The
 * short-lived access token stays in memory and is re-derived after restarts.
 */
export interface TokenStore {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

const REFRESH_TOKEN_KEY = 'ogc.refreshToken';

/** Readable only while the device is unlocked, and never migrated to backups or new devices. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureTokenStore: TokenStore = {
  getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
  setRefreshToken: (token) => SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS),
  clear: () => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
};
