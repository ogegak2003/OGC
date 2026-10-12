import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './password-hasher.js';

const hasher = new PasswordHasher();
const password = 'correct horse battery staple';

describe('PasswordHasher', () => {
  it('produces salted Argon2id PHC hashes that never contain the password', async () => {
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
  });

  it('verifies correct passwords and rejects wrong ones', async () => {
    const stored = await hasher.hash(password);
    await expect(hasher.verify(stored, password)).resolves.toBe(true);
    await expect(hasher.verify(stored, 'wrong password entirely')).resolves.toBe(false);
  });

  it('treats malformed hashes as a failed verification', async () => {
    await expect(hasher.verify('not-a-hash', password)).resolves.toBe(false);
  });

  it('flags hashes with outdated parameters for rehashing', async () => {
    expect(hasher.needsRehash(await hasher.hash(password))).toBe(false);
    expect(
      hasher.needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo'),
    ).toBe(true);
    expect(hasher.needsRehash('$2b$10$bcryptstylehash')).toBe(true);
  });

  it('runs a dummy verification for unknown accounts', async () => {
    await expect(hasher.verifyAgainstDummy(password)).resolves.toBeUndefined();
  });
});
