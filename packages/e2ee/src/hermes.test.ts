import { describe, expect, it } from 'vitest';

/**
 * Simulates React Native's Hermes runtime: `crypto.getRandomValues` exists
 * (expo-crypto), `crypto.subtle` does not. The whole MLS flow must work with
 * only the KDF shim installed. Vitest isolates each test file, so replacing
 * the global here does not affect other suites.
 */
describe('MLS without WebCrypto (Hermes simulation)', () => {
  it('runs group creation, add, join, encrypt and decrypt with only the KDF shim', async () => {
    const real = globalThis.crypto;
    const hermesCrypto = {
      getRandomValues: real.getRandomValues.bind(real),
      randomUUID: real.randomUUID.bind(real),
    };
    Object.defineProperty(globalThis, 'crypto', { value: hermesCrypto, configurable: true });
    try {
      expect((globalThis.crypto as { subtle?: unknown }).subtle).toBeUndefined();
      const { installSubtleKdfShim } = await import('./kdf-subtle-shim.js');
      expect(installSubtleKdfShim()).toBe(true);
      expect(installSubtleKdfShim()).toBe(false);

      const { MlsGroup, generateKeyPackages, messageAad } = await import('./mls.js');
      const { directoryOf, makeDevice } = await import('./test-helpers.js');
      const { fromUtf8, utf8 } = await import('./bytes.js');

      const alice = await makeDevice('OGC482731905');
      const bob = await makeDevice('OGC193847562');
      const directory = directoryOf(alice, bob);
      const [bobKp] = await generateKeyPackages(bob, 1);
      if (!bobKp) throw new Error('no key package');
      const aliceGroup = await MlsGroup.create(alice, 'conv-hermes', directory);
      const commit = await aliceGroup.commit({ add: [bobKp.publicKey] });
      const bobGroup = await MlsGroup.joinFromWelcome(commit.welcome ?? '', bobKp, directory);

      const aad = messageAad('conv-hermes', 'c-1');
      const { ciphertext } = await commit.group.encrypt(utf8('works on Hermes'), aad);
      const { plaintext } = await bobGroup.decrypt(ciphertext, aad);
      expect(fromUtf8(plaintext)).toBe('works on Hermes');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});
