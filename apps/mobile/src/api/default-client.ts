import { Platform } from 'react-native';
import { secureTokenStore } from '../auth/token-store';
import { ApiClient } from './client';

/**
 * `EXPO_PUBLIC_*` values are compiled into the app and are public. On a
 * physical device, point this at your computer's LAN address.
 */
const configured: unknown = process.env.EXPO_PUBLIC_API_BASE_URL;
const baseUrl = typeof configured === 'string' ? configured : 'http://localhost:3000/api';

export const apiClient = new ApiClient({
  baseUrl,
  platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
  store: secureTokenStore,
});
