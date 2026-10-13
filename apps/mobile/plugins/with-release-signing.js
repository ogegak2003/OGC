// @ts-check
const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Android release signing for local builds (docs/development/mobile.md).
 *
 * Expo's generated project signs release builds with the shared debug key,
 * which must never be distributed. This plugin replaces that with an upload
 * keystore read from Gradle properties, which you provide outside the
 * repository — in `%USERPROFILE%\.gradle\gradle.properties` or as
 * `ORG_GRADLE_PROJECT_*` environment variables:
 *
 *   OGC_UPLOAD_STORE_FILE=C:\\path\\to\\upload.keystore
 *   OGC_UPLOAD_STORE_PASSWORD=…
 *   OGC_UPLOAD_KEY_ALIAS=…
 *   OGC_UPLOAD_KEY_PASSWORD=…
 *
 * Without them, `assembleRelease` / `bundleRelease` produce **unsigned**
 * artifacts (not installable), never debug-signed ones. EAS Build manages its
 * own credentials and is unaffected.
 */
const SIGNING_BLOCK = `
        release {
            if (project.hasProperty('OGC_UPLOAD_STORE_FILE')) {
                storeFile file(OGC_UPLOAD_STORE_FILE)
                storePassword OGC_UPLOAD_STORE_PASSWORD
                keyAlias OGC_UPLOAD_KEY_ALIAS
                keyPassword OGC_UPLOAD_KEY_PASSWORD
            }
        }`;

/** @param {string} gradle */
function applySigning(gradle) {
  if (gradle.includes('OGC_UPLOAD_STORE_FILE')) return gradle;
  const debugConfig = /signingConfigs\s*\{\s*debug\s*\{[^}]*\}/;
  if (!debugConfig.test(gradle)) {
    throw new Error('with-release-signing: signingConfigs block not found in app/build.gradle');
  }
  let next = gradle.replace(debugConfig, (match) => `${match}${SIGNING_BLOCK}`);
  // In buildTypes.release, replace the debug signing with the upload key (or none).
  const releaseType =
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!releaseType.test(next)) {
    throw new Error('with-release-signing: release build type not found in app/build.gradle');
  }
  next = next.replace(
    releaseType,
    "$1signingConfig project.hasProperty('OGC_UPLOAD_STORE_FILE') ? signingConfigs.release : null",
  );
  return next;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('with-release-signing: only Groovy build.gradle is supported');
    }
    mod.modResults.contents = applySigning(mod.modResults.contents);
    return mod;
  });

module.exports = withReleaseSigning;
module.exports.applySigning = applySigning;
