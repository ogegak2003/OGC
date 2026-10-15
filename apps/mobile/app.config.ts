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

/** Shown by iOS (and in Android rationale dialogs) when a call first needs the device. */
const CAMERA_USAGE = 'OGC uses your camera only during video calls you make or answer.';
const MICROPHONE_USAGE = 'OGC uses your microphone for voice messages you record and during calls.';

const VERSION = '0.1.0';
/** Increase for every store upload (EAS can manage it remotely: `autoIncrement`). */
const BUILD_NUMBER = 1;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'OGC',
  slug: 'ogc',
  // Expo account that owns the EAS project (builds, credentials, environment variables).
  owner: 'obagaglobal-ltd',
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
    // Firebase project file for push delivery on Android: a path from the environment (an EAS
    // "file" environment variable in cloud builds). Never committed; see
    // docs/development/notifications.md.
    ...(env.GOOGLE_SERVICES_JSON ? { googleServicesFile: env.GOOGLE_SERVICES_JSON } : {}),
    // Only what OGC uses: network, the microphone (voice messages and calls), the camera (video
    // calls only, requested when one starts), notifications.
    permissions: ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'CAMERA'],
    blockedPermissions: [
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
        // Not `false`: that would block the CAMERA permission video calls need (and RECORD_AUDIO,
        // which voice messages and calls need). The image picker itself never opens the camera.
        cameraPermission: CAMERA_USAGE,
      },
    ],
    [
      'expo-audio',
      {
        microphonePermission: MICROPHONE_USAGE,
        // Voice messages play in the foreground only: no background service or permissions.
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    // Calls (Phase 6): native WebRTC. Not available in Expo Go — use a development build.
    [
      '@config-plugins/react-native-webrtc',
      { cameraPermission: CAMERA_USAGE, microphonePermission: MICROPHONE_USAGE },
    ],
    // Development builds load JavaScript from Metro like Expo Go, with OGC's own native code.
    'expo-dev-client',
    // Push notifications (Phase 7). Android delivery needs Firebase credentials
    // (GOOGLE_SERVICES_JSON below and an FCM key in EAS); iOS needs an APNs key in EAS.
    [
      'expo-notifications',
      {
        icon: './assets/android-icon-monochrome.png',
        color: '#D4AA4F',
        defaultChannel: 'ogc-alerts',
      },
    ],
    './plugins/with-release-signing',
    './plugins/with-short-native-build-paths',
  ],
  extra: {
    profile: PROFILE,
    // EAS project @obagaglobal-ltd/ogc (created with `eas init`). Keep this ID: changing it
    // detaches the app from its builds, credentials and environment variables.
    eas: { projectId: '20ebd5df-819e-4aa6-a904-bd10969bae5f' },
  },
});
