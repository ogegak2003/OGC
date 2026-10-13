/**
 * Repeatable local Android build (docs/development/mobile.md).
 *
 *   pnpm --filter @ogc/mobile android:build debug     → app-debug.apk (loads JS from Metro)
 *   pnpm --filter @ogc/mobile android:build release   → app-release.apk (JS embedded)
 *   pnpm --filter @ogc/mobile android:build bundle    → app-release.aab (Play Store upload)
 *
 * Uses JAVA_HOME / ANDROID_HOME from the environment, or the repository-local
 * toolchain in `.toolchain/` if present. Regenerates `android/` from
 * app.config.ts first (it is generated code and git-ignored). Release builds are
 * signed only when OGC_UPLOAD_* Gradle properties are provided (see
 * plugins/with-release-signing.js); otherwise they are unsigned.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MOBILE = resolve(import.meta.dirname, '..');
const ROOT = resolve(MOBILE, '../..');
const kind = process.argv[2] ?? 'debug';
const TASKS = {
  debug: ':app:assembleDebug',
  release: ':app:assembleRelease',
  bundle: ':app:bundleRelease',
};
const task = TASKS[kind];
if (!task) {
  console.error(`Unknown build "${kind}". Use: ${Object.keys(TASKS).join(' | ')}`);
  process.exit(2);
}

const env = { ...process.env };
const local = join(ROOT, '.toolchain');
if (!env.JAVA_HOME && existsSync(join(local, 'jdk'))) {
  const jdk = readdirSync(join(local, 'jdk')).find((d) => d.startsWith('jdk'));
  if (jdk) env.JAVA_HOME = join(local, 'jdk', jdk);
}
if (!env.ANDROID_HOME && existsSync(join(local, 'sdk'))) env.ANDROID_HOME = join(local, 'sdk');
if (!env.JAVA_HOME || !env.ANDROID_HOME) {
  console.error(
    'JAVA_HOME (JDK 17) and ANDROID_HOME (Android SDK) are required. See docs/development/mobile.md.',
  );
  process.exit(1);
}
const windows = process.platform === 'win32';
env.PATH = `${join(env.JAVA_HOME, 'bin')}${windows ? ';' : ':'}${env.PATH ?? ''}`;

const run = (command, args, cwd) => {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: windows });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], MOBILE);
const androidDir = join(MOBILE, 'android');
// Debug builds: only the ABIs of current phones (arm64-v8a) and emulators (x86_64), to halve
// native compile time. Release builds keep every ABI. Override with OGC_ANDROID_ABIS.
const abis = env.OGC_ANDROID_ABIS ?? (kind === 'debug' ? 'arm64-v8a,x86_64' : undefined);
// Arguments pass through a shell on Windows (gradlew.bat): accept ABI names only.
if (abis && !/^[a-z0-9_-]+(,[a-z0-9_-]+)*$/.test(abis)) {
  console.error(`Invalid OGC_ANDROID_ABIS "${abis}" (example: arm64-v8a,x86_64)`);
  process.exit(2);
}
const gradleArgs = [task, '--no-daemon', ...(abis ? [`-PreactNativeArchitectures=${abis}`] : [])];
run(join(androidDir, windows ? 'gradlew.bat' : 'gradlew'), gradleArgs, androidDir);

const outputs = {
  debug: 'android/app/build/outputs/apk/debug/app-debug.apk',
  release: 'android/app/build/outputs/apk/release',
  bundle: 'android/app/build/outputs/bundle/release',
};
console.log(`\nArtifact location: ${join(MOBILE, outputs[kind])}`);
