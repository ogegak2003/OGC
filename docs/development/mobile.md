# Mobile apps (Android and iOS)

OGC's mobile app is a **native React Native app** built with Expo (SDK 57, React Native 0.86,
Hermes). It is not a web view: screens are native components, navigation uses the native
back button and gestures, keys live in the platform keystore (`expo-secure-store`), and the
end-to-end encryption engine runs on the device.

| Item                            | Value                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App name                        | OGC                                                                                                                                                                                            |
| Android package / iOS bundle ID | `com.obagaglobal.ogc`                                                                                                                                                                          |
| Version                         | `0.1.0` (`app.config.ts`); build number `versionCode` / `buildNumber`                                                                                                                          |
| Orientation                     | Portrait (iPad runs full screen)                                                                                                                                                               |
| Configuration                   | `apps/mobile/app.config.ts`, `apps/mobile/eas.json`                                                                                                                                            |
| Icons / splash                  | `apps/mobile/assets/` (regenerate: `pnpm --filter @ogc/mobile assets`); the splash is configured through the `expo-splash-screen` plugin in `app.config.ts` (SDK 57 has no top-level `splash`) |
| Appearance                      | Always dark (`userInterfaceStyle: 'dark'`, applied on Android by `expo-system-ui`)                                                                                                             |

Native projects (`apps/mobile/android/`, `apps/mobile/ios/`) are **generated** by
`expo prebuild` from `app.config.ts` and are git-ignored. Change the config, not the
generated files.

## Endpoints (API, realtime, invitation links)

The app talks to one origin: REST at `<API>/v1/…` and realtime (Socket.IO) at
`<API origin>/api/realtime` — an `https://` API means a `wss://` realtime connection.

| Situation                      | `EXPO_PUBLIC_API_BASE_URL`                                                    | `EXPO_PUBLIC_WEB_APP_URL`         |
| ------------------------------ | ----------------------------------------------------------------------------- | --------------------------------- |
| Android emulator (development) | _unset_ → `http://10.0.2.2:3000/api` (the emulator's alias for your computer) | _unset_ → `http://localhost:5173` |
| iOS simulator (development)    | _unset_ → `http://localhost:3000/api`                                         | _unset_                           |
| Physical phone (development)   | `http://<your computer's LAN IP>:3000/api`                                    | optional                          |
| Preview / production builds    | **required**, public `https://…/api`                                          | **required**, public `https://…`  |

- Set them in `apps/mobile/.env` (copy `.env.example`; the file is git-ignored) or in the
  shell. `EXPO_PUBLIC_*` values are compiled into the app and are **public** — never secrets.
- `app.config.ts` refuses preview/production builds whose URLs are missing, plain HTTP,
  `localhost` or a private/LAN address. A release build with no valid URL shows a
  configuration error instead of calling a developer machine.
- Release Android builds do not allow cleartext HTTP (only the debug variant does). iOS
  preview/production builds allow HTTPS only (App Transport Security with no exceptions);
  development builds additionally allow local-network HTTP (`NSAllowsLocalNetworking`) for a
  local API. TLS checks are never disabled.

**Physical phone on your network (development only):** the phone and computer must be on
the same network and able to reach each other — no client isolation on the Wi-Fi, and the
Windows firewall must allow inbound TCP 3000 (API) and 8081 (Metro) on _Private_ networks.
Find your IP with `ipconfig` (IPv4 of the Wi-Fi adapter). Never commit a LAN address.

```powershell
# apps/mobile/.env (example)
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000/api
```

## Development

```powershell
pnpm install
pnpm db:up                         # PostgreSQL + Redis (Docker)
pnpm --filter @ogc/api dev         # API on http://localhost:3000 (listens on all interfaces)
pnpm --filter @ogc/mobile dev      # Expo dev server (Metro) on :8081
```

In the Expo terminal press `a` for an Android emulator or `i` for an iOS simulator (macOS),
or open the app on a phone. Expo Go works for quick UI work; the native development build
below is closer to production (secure storage, permissions, native modules).

### Android emulator

1. Install Android Studio (or the SDK command-line tools) and create a virtual device
   (Pixel, API 35/36).
2. Start the emulator, then: `pnpm --filter @ogc/mobile android` (`expo run:android` builds the
   native debug app, installs it and starts Metro). Leave `EXPO_PUBLIC_API_BASE_URL` unset.

### Physical Android phone

1. Enable _Developer options → USB debugging_, connect the phone, accept the prompt; check with
   `adb devices`.
2. Set `EXPO_PUBLIC_API_BASE_URL` to your LAN address (above), then
   `pnpm --filter @ogc/mobile android`. Or install a built APK (below) with
   `adb install -r <path-to-apk>`.

## Building Android

Requirements: **JDK 17** and the **Android SDK** (platform 36, build-tools 36.0.0,
NDK 27.1.12297006, CMake 3.22.1), with `JAVA_HOME` and `ANDROID_HOME` set — or the
repository-local toolchain in `.toolchain/` (git-ignored), which the build script uses
automatically when the variables are unset.

Debug builds compile native code for `arm64-v8a` (phones) and `x86_64` (emulators) only;
release builds include every ABI. Set `OGC_ANDROID_ABIS` (e.g. `arm64-v8a`) to override.

**Windows:** pnpm's deep `node_modules/.pnpm/…` paths would push CMake object files past the
260-character path limit (`ninja: error: manifest 'build.ninja' still dirty`). The
`plugins/with-short-native-build-paths.js` config plugin stages native builds under
`android/build/cxx/` to avoid this; no system setting needs changing.

```powershell
pnpm --filter @ogc/mobile android:build debug     # debug APK
pnpm --filter @ogc/mobile android:build release   # release APK (embedded JS bundle)
pnpm --filter @ogc/mobile android:build bundle    # release AAB for Google Play
```

| Build       | Output                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debug APK   | `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` — needs Metro (`pnpm --filter @ogc/mobile dev`) running and reachable; cleartext HTTP allowed for local APIs |
| Release APK | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` (signed) or `app-release-unsigned.apk` (no key provided)                                                 |
| Release AAB | `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`                                                                                                       |

Release builds need public HTTPS endpoints (`OGC_APP_ENV=preview` or `production` plus the
two `EXPO_PUBLIC_*` URLs).

### Signing a release (local)

Release builds are signed with **your upload key**, supplied outside the repository; without
it they are left unsigned (never debug-signed). Create a key once and keep it (and its
passwords) in a password manager — losing it blocks updates:

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore C:\secure\ogc-upload.keystore -alias ogc-upload -keyalg RSA -keysize 4096 -validity 10000
```

Provide the properties in `%USERPROFILE%\.gradle\gradle.properties` (never in the repo):

```properties
OGC_UPLOAD_STORE_FILE=C:\\secure\\ogc-upload.keystore
OGC_UPLOAD_STORE_PASSWORD=…
OGC_UPLOAD_KEY_ALIAS=ogc-upload
OGC_UPLOAD_KEY_PASSWORD=…
```

or as environment variables `ORG_GRADLE_PROJECT_OGC_UPLOAD_STORE_FILE`, etc. Then:

```powershell
$env:OGC_APP_ENV = "production"
$env:EXPO_PUBLIC_API_BASE_URL = "https://api.your-domain.example/api"
$env:EXPO_PUBLIC_WEB_APP_URL = "https://your-domain.example"
pnpm --filter @ogc/mobile android:build bundle
```

Upload the AAB to Google Play with **Play App Signing** enabled (Google keeps the app signing
key; you keep the upload key). For local builds, increase `BUILD_NUMBER` in `app.config.ts`
for every upload; EAS builds number themselves (below).

### EAS Build (cloud, Android and iOS)

EAS commands run from **`apps/mobile`** (the Expo project inside the pnpm workspace; EAS
uploads the whole repository and installs it with pnpm). The CLI is used through `npx` at a
pinned version, so no global install is needed:

```powershell
cd C:\Users\PC\OGC\apps\mobile
npx eas-cli@24.13.0 login        # your Expo account; credentials are typed in your terminal
npx eas-cli@24.13.0 whoami       # check
npx eas-cli@24.13.0 init         # once: creates/links the EAS project and adds its ID to the config
```

The project is **`@obagaglobal-ltd/ogc`** (ID `20ebd5df-819e-4aa6-a904-bd10969bae5f`), owned by
the `obagaglobal-ltd` Expo organisation (`owner` and `extra.eas.projectId` in `app.config.ts`).
`eas init` cannot edit a TypeScript config, so the ID was added by hand; keep it: a different
ID detaches the app from its builds, credentials and environment variables. Account members
need access to the `obagaglobal-ltd` organisation on expo.dev.

| Profile (`eas.json`) | iOS                                                      | Android   | Endpoints                    |
| -------------------- | -------------------------------------------------------- | --------- | ---------------------------- |
| `development`        | Simulator, Debug (loads JavaScript from Metro)           | debug APK | emulator/simulator defaults  |
| `preview`            | Release, internal (ad hoc: registered iPhones)           | APK       | EAS `preview` environment    |
| `production`         | Release, **store** distribution (TestFlight / App Store) | AAB       | EAS `production` environment |

All profiles extend `base`, which pins **Node 24.18.0** and **pnpm 11.12.0** to match the
repository (`engines`, `packageManager`; the workspace uses pnpm 11 settings). Build numbers
are managed by EAS (`appVersionSource: remote`, `autoIncrement` on production), starting
from the value in `app.config.ts`.

Preview and production builds read their public endpoints from EAS environment variables.
`app.config.ts` stops the build if they are missing, plain HTTP, localhost or a LAN address:

```powershell
npx eas-cli@24.13.0 env:create --environment production --name EXPO_PUBLIC_API_BASE_URL --value https://api.your-domain.example/api --visibility plaintext
npx eas-cli@24.13.0 env:create --environment production --name EXPO_PUBLIC_WEB_APP_URL --value https://your-domain.example --visibility plaintext
npx eas-cli@24.13.0 config --platform ios --profile production   # resolved configuration
```

They are public values (compiled into the app). Never store secrets in `EXPO_PUBLIC_*`.

```powershell
npx eas-cli@24.13.0 build --platform android --profile preview      # installable APK
npx eas-cli@24.13.0 build --platform android --profile production   # AAB for Google Play
```

EAS stores signing credentials on Expo's servers (or uses yours). Local credential files
(`credentials.json`, `credentials/`, `*.p12`, `*.p8`, `*.mobileprovision`, `*.keystore`) are
git-ignored; never commit them.

## Building iOS

iOS apps can only be compiled on **macOS with Xcode**. On Windows, use **EAS Build** (cloud
macOS builders), from `apps/mobile`:

| Goal                                 | Command                                                                              | Requirements                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Native compile check / Simulator app | `npx eas-cli@24.13.0 build --platform ios --profile development`                     | Expo account only                                                                                       |
| Install on registered iPhones        | `npx eas-cli@24.13.0 device:create`, then `… build --platform ios --profile preview` | Apple Developer Program (paid), registered devices, `preview` endpoints                                 |
| TestFlight / App Store               | `… build --platform ios --profile production`, then `… submit --platform ios`        | Apple Developer Program, production HTTPS endpoints, App Store Connect record for `com.obagaglobal.ogc` |

**Verified:** the `development` profile built successfully on EAS on 2026-10-13 (build
`a7134ac1-1fa6-40d0-ad66-838b9ab369b2`, about 6 minutes): a universal (arm64 + x86_64)
`OGC.app` for the iOS Simulator, iOS 16.4+. To run such a build you need a Mac with Xcode:
`npx eas-cli@24.13.0 build:run --platform ios --latest` installs it in a simulator; start
Metro (`pnpm --filter @ogc/mobile dev`) because Debug builds load JavaScript from it.

**Signing.** Device and store builds must be signed, which needs an **Apple Developer
Program** membership ($99/year) on the Apple ID that will own the app. Run the first such
build interactively in your own terminal: EAS asks you to sign in to Apple there and then
creates and stores the distribution certificate and provisioning profile. Do not share
Apple passwords or codes with anyone else. Check what EAS holds with
`npx eas-cli@24.13.0 credentials --platform ios`.

**Not dependent on a development server.** `preview` and `production` use the Release
configuration, which embeds the JavaScript bundle; there is no development client. Only the
`development` profile loads JavaScript from Metro.

**Production network security.** Release builds use HTTPS only (App Transport Security
without exceptions); an `https://` API also makes realtime use `wss://`.

iOS configuration in `app.config.ts`: bundle ID `com.obagaglobal.ogc`, portrait, full screen
on iPad, microphone and photo-library usage descriptions only (no camera or Face ID), dark
interface. Keys are stored in the iOS Keychain through `expo-secure-store`. When submitting,
answer App Store Connect's encryption export questions accurately: OGC uses end-to-end
encryption. On a Mac you can also build locally: `npx expo prebuild --platform ios` then
`npx expo run:ios --device` (Xcode 16+, CocoaPods).

### Troubleshooting EAS

- **"An Expo user account is required"**: run `npx eas-cli@24.13.0 login`.
- **"EXPO_PUBLIC_API_BASE_URL must be set / must be a public https URL"** on preview or
  production: create the environment variables above for that environment.
- **Install step fails on pnpm settings**: the profile must extend `base` (pnpm 11).
- **"missing ios.infoPlist.ITSAppUsesNonExemptEncryption"** warning: expected. It is left
  unset on purpose because OGC uses end-to-end encryption, which must be declared in App
  Store Connect (export compliance) rather than marked exempt.
- **"Resolved … environment"** shows which EAS environment a build uses; every profile in
  `eas.json` names its own (`development`, `preview`, `production`).
- **Signing prompts in a non-interactive run**: run the build once without
  `--non-interactive` so EAS can set up credentials with your Apple account.

## Checks

```powershell
pnpm --filter @ogc/mobile typecheck
pnpm --filter @ogc/mobile lint
pnpm --filter @ogc/mobile test
npx expo config --type public                     # resolved app configuration (in apps/mobile)
npx expo export --platform android --platform ios # JavaScript bundles (in apps/mobile)
npx expo config --type introspect                 # Info.plist / manifest values after plugins
npx expo-doctor                                   # SDK compatibility and native peer dependencies
```

A build that compiles and unit tests that pass do not replace testing on an emulator and on
physical devices.
