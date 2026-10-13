import { Platform } from 'react-native';
import { secureTokenStore } from '../auth/token-store';
import { runtimeConfig } from '../config/runtime';
import { ApiClient } from './client';

/**
 * The app's API client. The base URL comes from the build configuration
 * (src/config/endpoints.ts); the realtime connection uses the same origin, so
 * an https API means a wss realtime connection. A misconfigured release build
 * gets no client and shows a configuration error instead of calling localhost.
 */
export const apiClient: ApiClient | undefined = runtimeConfig.endpoints
  ? new ApiClient({
      baseUrl: runtimeConfig.endpoints.apiBaseUrl,
      platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
      store: secureTokenStore,
    })
  : undefined;
