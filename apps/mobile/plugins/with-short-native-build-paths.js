// @ts-check
const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Keeps native (CMake) build paths short enough for Windows.
 *
 * pnpm places packages deep inside `node_modules/.pnpm/<long-name>/…`, and
 * CMake builds a library (expo-modules-core) in `<package>/android/.cxx`,
 * naming object files after their absolute source paths. On Windows that
 * exceeds the 260-character path limit and the build fails with
 * "ninja: error: manifest 'build.ninja' still dirty after 100 tries".
 * Staging native builds under `android/build/cxx/<module>` instead lets CMake
 * fall back to short hashed object names. Harmless on macOS/Linux and EAS.
 */
const MARKER = '// @generated ogc-short-native-build-paths';
const BLOCK = `
${MARKER}
subprojects { sub ->
  sub.plugins.withId('com.android.library') {
    sub.android.externalNativeBuild.cmake.buildStagingDirectory =
      new File(rootProject.projectDir, "build/cxx/\${sub.name}")
  }
}
`;

/** @param {string} gradle */
function applyShortPaths(gradle) {
  return gradle.includes(MARKER) ? gradle : `${gradle.trimEnd()}\n${BLOCK}`;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withShortNativeBuildPaths = (config) =>
  withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('with-short-native-build-paths: only Groovy build.gradle is supported');
    }
    mod.modResults.contents = applyShortPaths(mod.modResults.contents);
    return mod;
  });

module.exports = withShortNativeBuildPaths;
module.exports.applyShortPaths = applyShortPaths;
