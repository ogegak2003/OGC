import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

/**
 * Argon2id with OWASP's recommended minimum parameters (19 MiB, t=2, p=1).
 * Hashes are self-describing PHC strings, so parameters can be raised later and
 * existing hashes upgraded transparently at the next successful login.
 *
 * The algorithm is the library default, Argon2id (asserted by tests: the
 * `Algorithm` const enum cannot be referenced under `verbatimModuleSyntax`).
 */
export const ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const PHC_PARAMS = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

@Injectable()
export class PasswordHasher {
  /** A valid hash of a random value, verified against when an account does not exist. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_PARAMS);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Performs a full Argon2 verification that always fails, so responses for
   * unknown accounts take as long as those for wrong passwords.
   */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('base64url'));
    await this.verify(await this.dummyHash, password);
  }

  needsRehash(storedHash: string): boolean {
    const match = PHC_PARAMS.exec(storedHash);
    if (!match) return true;
    const [, m, t, p] = match.map(Number);
    return (
      m !== ARGON2_PARAMS.memoryCost ||
      t !== ARGON2_PARAMS.timeCost ||
      p !== ARGON2_PARAMS.parallelism
    );
  }
}
