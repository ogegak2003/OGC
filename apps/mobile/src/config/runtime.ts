import { Platform } from 'react-native';
import { type Endpoints, resolveEndpoints } from './endpoints';

/**
 * The endpoints of this build, resolved once at start-up. `EXPO_PUBLIC_*`
 * variables must be read with literal property access so Expo can inline them.
 */
function load():
  { endpoints: Endpoints; error?: undefined } | { endpoints?: undefined; error: string } {
  try {
    return {
      endpoints: resolveEndpoints({
        apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
        webAppUrl: process.env.EXPO_PUBLIC_WEB_APP_URL,
        dev: __DEV__,
        platform: Platform.OS,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid configuration' };
  }
}

export const runtimeConfig = load();

/** Origin of invitation links shared from the app. */
export const webAppUrl = runtimeConfig.endpoints?.webAppUrl ?? '';
