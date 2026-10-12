import { isOgcId } from '@ogc/validation';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { IdentityService, MAX_OGC_ID_ATTEMPTS, OgcIdAllocationError } from './identity.service.js';
import { OgcIdGenerator, type RandomIntSource, secureRandomInt } from './ogc-id.generator.js';

function uniqueViolation(field: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [field] },
  });
}

describe('OgcIdGenerator', () => {
  it('produces valid OGC IDs from the CSPRNG', () => {
    const generator = new OgcIdGenerator(secureRandomInt);
    for (let i = 0; i < 1_000; i++) {
      expect(isOgcId(generator.next())).toBe(true);
    }
  });

  it('requests numbers across the full 9-digit range', () => {
    const random = vi.fn<RandomIntSource>(() => 482_731_905);
    expect(new OgcIdGenerator(random).next()).toBe('OGC482731905');
    expect(random).toHaveBeenCalledWith(100_000_000, 1_000_000_000);
  });

  it('has no sequential dependency between consecutive IDs', () => {
    const generator = new OgcIdGenerator(secureRandomInt);
    const values = Array.from({ length: 2_000 }, () => Number(generator.next().slice(3)));

    // Effectively unique (birthday bound for 2 000 draws from 9e8 is ~0.2%).
    expect(new Set(values).size).toBeGreaterThanOrEqual(values.length - 1);
    // Not monotonic, and consecutive differences are not constant.
    const differences = new Set(values.slice(1).map((v, i) => v - (values[i] ?? 0)));
    expect(differences.size).toBeGreaterThan(values.length * 0.99);
    expect(values.some((v, i) => i > 0 && v < (values[i - 1] ?? 0))).toBe(true);
    expect(values.some((v, i) => i > 0 && v > (values[i - 1] ?? 0))).toBe(true);
    // Spread over the whole space: every leading digit 1–9 occurs.
    expect(new Set(values.map((v) => String(v)[0])).size).toBe(9);
  });

  it('depends only on the random source', () => {
    const sequence = [111_111_111, 999_999_999, 500_000_000];
    const random: RandomIntSource = () => sequence.shift() ?? 0;
    const generator = new OgcIdGenerator(random);
    expect([generator.next(), generator.next(), generator.next()]).toEqual([
      'OGC111111111',
      'OGC999999999',
      'OGC500000000',
    ]);
  });
});

describe('IdentityService.withNewOgcId', () => {
  const ids = [123_456_789, 234_567_891, 345_678_912, 456_789_123, 567_891_234, 678_912_345];

  function service(): IdentityService {
    const queue = [...ids];
    return new IdentityService(new OgcIdGenerator(() => queue.shift() ?? 0));
  }

  it('passes a fresh ID to the create callback', async () => {
    await expect(service().withNewOgcId((id) => Promise.resolve(id))).resolves.toBe('OGC123456789');
  });

  it('retries with a new ID when the ID collides', async () => {
    const attempts: string[] = [];
    const result = await service().withNewOgcId((id) => {
      attempts.push(id);
      return attempts.length < 3 ? Promise.reject(uniqueViolation('ogc_id')) : Promise.resolve(id);
    });
    expect(attempts).toEqual(['OGC123456789', 'OGC234567891', 'OGC345678912']);
    expect(result).toBe('OGC345678912');
  });

  it('gives up after the maximum number of collisions', async () => {
    const create = vi.fn(() => Promise.reject(uniqueViolation('ogc_id')));
    await expect(service().withNewOgcId(create)).rejects.toBeInstanceOf(OgcIdAllocationError);
    expect(create).toHaveBeenCalledTimes(MAX_OGC_ID_ATTEMPTS);
  });

  it('does not retry other errors, including other unique violations', async () => {
    const emailClash = vi.fn(() => Promise.reject(uniqueViolation('email')));
    await expect(service().withNewOgcId(emailClash)).rejects.toMatchObject({ code: 'P2002' });
    expect(emailClash).toHaveBeenCalledTimes(1);
  });
});
