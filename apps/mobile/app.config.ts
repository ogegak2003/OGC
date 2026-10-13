import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * OGC native app configuration (Android and iOS). See docs/development/mobile.md.
 *
 * Build profile (`OGC_APP_ENV`): `development` (default), `preview`, `production`.
 * Preview and production builds must point at public HTTPS endpoints — the
 * configuration refuses localhost, LAN addresses and plain HTTP, so a release
 * build can never ship pointing at a developer's machine.
 */
const env = process.env as Record<string, string | undefined>;
const PROFILE = env.OGC_APP_ENV ?? 'development';
const RELEASE = PROFILE === 'preview' || PROFILE === 'production';

/**
 * Same rule as `isLocalHost` in src/config/endpoints.ts (the app's own run-time check);
 * Expo's config loader cannot import application TypeScript, so it is repeated here.
 */
function isLocalHost(hostname: string): boolean {
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

function requirePublicHttps(name: string): void {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set for ${PROFILE} builds`);
  const { protocol, hostname } = new URL(value);
  if (protocol !== 'https:' || isLocalHost(hostname)) {
    throw new Error(`${name} must be a public https URL for ${PROFILE} builds (got ${value})`);
  }
}

if (RELEASE) {
  requirePublicHttps('EXPO_PUBLIC_API_BASE_URL');
  requirePublicHttps('EXPO_PUBLIC_WEB_APP_URL');
}

const VERSION = '0.1.0';
/** Increase for every store upload (EAS can manage it remotely: `autoIncrement`). */
const BUILD_NUMBER = 1;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'OGC',
  slug: 'ogc',
  scheme: 'ogc',
  version: VERSION,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0B0B0A',
  primaryColor: '#D4AA4F',
  ios: {
    bundleIdentifier: 'com.obagaglobal.ogc',
    buildNumber: String(BUILD_NUMBER),
    supportsTablet: true,
    // Portrait only, so iPad runs it full screen (no Split View).
    requireFullScreen: true,
    // Encryption export compliance is declared in App Store Connect (OGC uses end-to-end
    // encryption); deliberately not set to "exempt" here.
    infoPlist: {
      // App Transport Security: release builds allow HTTPS only. Development builds may reach
      // a local API over HTTP (simulator localhost or a LAN address), like Android debug builds.
      NSAppTransportSecurity: RELEASE
        ? { NSAllowsArbitraryLoads: false }
        : { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true },
    },
  },
  android: {
    package: 'com.obagaglobal.ogc',
    versionCode: BUILD_NUMBER,
    adaptiveIcon: {
      backgroundColor: '#0B0B0A',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // Keys and messages never leave the device through Android backups.
    allowBackup: false,
    predictiveBackGestureEnabled: false,
    softwareKeyboardLayoutMode: 'resize',
    // Only what OGC uses: network, the microphone for voice messages, notifications.
    permissions: ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS'],
    blockedPermissions: [
      'android.permission.CAMERA',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
    ],
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    // Native splash screen (SDK 57 configures it here, not with a top-level `splash`). No `dark`
    // variant: OGC is always dark, and one would switch iOS to the system appearance.
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#0B0B0A',
      },
    ],
    // Applies `userInterfaceStyle` and `backgroundColor` on Android.
    'expo-system-ui',
    // Keys are stored without biometric prompts, so no Face ID usage description.
    ['expo-secure-store', { faceIDPermission: false }],
    [
      'expo-image-picker',
      {
        photosPermission:
          'OGC uses your photos only when you choose one to send or as your profile picture.',
        cameraPermission: false,
        // Not `false`: that would block RECORD_AUDIO, which voice messages need (expo-audio).
      },
    ],
    [
      'expo-audio',
      {
        microphonePermission: 'OGC uses the microphone only while you record a voice message.',
        // Voice messages play in the foreground only: no background service or permissions.
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    './plugins/with-release-signing',
    './plugins/with-short-native-build-paths',
  ],
  extra: {
    profile: PROFILE,
  },
});
