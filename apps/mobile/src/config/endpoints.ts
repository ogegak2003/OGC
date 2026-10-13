/**
 * Where the app finds the OGC API (REST and realtime share one origin) and
 * the web app (used in shared invitation links).
 *
 * Values come from `EXPO_PUBLIC_API_BASE_URL` / `EXPO_PUBLIC_WEB_APP_URL`,
 * which are compiled into the app and are public by design. Development
 * builds fall back to the developer's machine as seen from the emulator or
 * simulator; release builds have no fallback and must use HTTPS
 * (docs/development/mobile.md).
 */
export interface Endpoints {
  /** e.g. `https://api.ogc.example/api` — REST under `/v1`, realtime under `/realtime`. */
  apiBaseUrl: string;
  /** e.g. `https://ogc.example` — origin of `/join#token=…` invitation links. */
  webAppUrl: string;
}

export class EndpointConfigurationError extends Error {
  override readonly name = 'EndpointConfigurationError';
}

/** Hosts that only make sense during local development. */
export function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === '[::1]'
  );
}

function parse(name: string, value: string, dev: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EndpointConfigurationError(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EndpointConfigurationError(`${name} must use https`);
  }
  if (!dev && (url.protocol !== 'https:' || isLocalHost(url.hostname))) {
    throw new EndpointConfigurationError(
      `${name} must be a public https URL in release builds (got ${url.origin})`,
    );
  }
  return value.replace(/\/+$/, '');
}

export function resolveEndpoints(input: {
  apiBaseUrl: unknown;
  webAppUrl: unknown;
  /** `__DEV__`: true for development builds and Expo Go. */
  dev: boolean;
  platform: string;
}): Endpoints {
  // The Android emulator reaches the host computer at 10.0.2.2; iOS simulators share its localhost.
  const devHost = input.platform === 'android' ? '10.0.2.2' : 'localhost';
  const api =
    typeof input.apiBaseUrl === 'string' && input.apiBaseUrl.trim() !== ''
      ? parse('EXPO_PUBLIC_API_BASE_URL', input.apiBaseUrl.trim(), input.dev)
      : input.dev
        ? `http://${devHost}:3000/api`
        : undefined;
  if (!api) {
    throw new EndpointConfigurationError('EXPO_PUBLIC_API_BASE_URL is not set for this build');
  }
  const web =
    typeof input.webAppUrl === 'string' && input.webAppUrl.trim() !== ''
      ? parse('EXPO_PUBLIC_WEB_APP_URL', input.webAppUrl.trim(), input.dev)
      : input.dev
        ? 'http://localhost:5173'
        : undefined;
  if (!web) {
    throw new EndpointConfigurationError('EXPO_PUBLIC_WEB_APP_URL is not set for this build');
  }
  return { apiBaseUrl: api, webAppUrl: web };
}
