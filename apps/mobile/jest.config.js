/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // The first test in a file pays for loading the crypto stack under Jest's transformer.
  testTimeout: 15_000,
  // jest-expo's defaults, plus the ESM-only libraries used by end-to-end encryption and realtime.
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@noble|@hpke|ts-mls|socket.io-client|socket.io-parser|engine.io-client|engine.io-parser|@socket.io))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
