import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskObjectStorage } from './adapters.js';

describe('LocalDiskObjectStorage', () => {
  let root: string;
  let storage: LocalDiskObjectStorage;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogc-storage-'));
    storage = new LocalDiskObjectStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores, reads and deletes objects under server-generated keys', async () => {
    const key = `avatars/${randomUUID()}.webp`;
    await storage.put(key, Buffer.from('image'), 'image/webp');
    expect((await storage.get(key))?.toString()).toBe('image');
    await storage.delete(key);
    expect(await storage.get(key)).toBeUndefined();
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it.each([
    '../escape.webp',
    'avatars/../../escape.webp',
    `avatars/${randomUUID()}.webp/../../x`,
    `/etc/${randomUUID()}.webp`,
    `avatars\\${randomUUID()}.webp`,
    `avatars/${randomUUID()}.exe`,
    'avatars/user-photo.webp',
  ])('rejects unsafe key %s', async (key) => {
    await expect(storage.put(key, Buffer.from('x'), 'image/webp')).rejects.toThrow(
      'Invalid storage key',
    );
    await expect(storage.get(key)).rejects.toThrow('Invalid storage key');
  });

  it('never overwrites an existing object', async () => {
    const key = `avatars/${randomUUID()}.webp`;
    await storage.put(key, Buffer.from('first'), 'image/webp');
    await expect(storage.put(key, Buffer.from('second'), 'image/webp')).rejects.toThrow();
    expect((await storage.get(key))?.toString()).toBe('first');
    expect(await readdir(join(root, 'avatars'))).toContain(key.split('/')[1]);
  });
});
