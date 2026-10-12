import { HttpException } from '@nestjs/common';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_BYTES, detectImageFormat, processAvatar } from './avatar-image.js';

const image = (format: 'png' | 'jpeg' | 'webp', width = 800, height = 600) =>
  sharp({ create: { width, height, channels: 3, background: { r: 212, g: 170, b: 79 } } })
    .toFormat(format)
    .toBuffer();

describe('detectImageFormat', () => {
  it('recognises JPEG, PNG and WebP by content', async () => {
    expect(detectImageFormat(await image('jpeg'))).toBe('jpeg');
    expect(detectImageFormat(await image('png'))).toBe('png');
    expect(detectImageFormat(await image('webp'))).toBe('webp');
  });

  it.each([
    ['Windows executable', Buffer.from('MZ\x90\x00 executable')],
    ['ELF binary', Buffer.from('\x7fELF binary')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['GIF', Buffer.from('GIF89a....')],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_label, data) => {
    expect(detectImageFormat(data)).toBeUndefined();
  });
});

describe('processAvatar', () => {
  it('produces a 512×512 WebP from any accepted format', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const output = await processAvatar(await image(format, 1200, 400));
      const meta = await sharp(output).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
    }
  });

  it('strips metadata such as EXIF', async () => {
    const withExif = await sharp(await image('jpeg'))
      .withExif({ IFD0: { Artist: 'secret-location-data' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const output = await processAvatar(withExif);
    expect((await sharp(output).metadata()).exif).toBeUndefined();
    expect(output.includes(Buffer.from('secret-location-data'))).toBe(false);
  });

  it('rejects non-images, truncated images and oversized uploads', async () => {
    await expect(processAvatar(Buffer.from('MZ not an image'))).rejects.toThrow(HttpException);
    const png = await image('png');
    await expect(processAvatar(png.subarray(0, 40))).rejects.toThrow(HttpException);
    const big = Buffer.concat([png, Buffer.alloc(AVATAR_MAX_BYTES)]);
    await expect(processAvatar(big)).rejects.toMatchObject({ status: 413 });
  });
});
