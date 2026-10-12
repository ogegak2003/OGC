import { HttpStatus } from '@nestjs/common';
import sharp from 'sharp';
import { ApiException } from '../../common/errors.js';

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_SIZE = 512;
/** Rejects decompression bombs before decoding (40 megapixels). */
const MAX_INPUT_PIXELS = 40_000_000;

type ImageFormat = 'jpeg' | 'png' | 'webp';

/**
 * Identifies an image by its leading bytes. Client-supplied filenames and MIME
 * types are never trusted; anything else (executables, SVG, HTML…) is rejected.
 */
export function detectImageFormat(data: Buffer): ImageFormat | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return undefined;
}

export const invalidMedia = (message = 'Upload a JPEG, PNG or WebP image'): ApiException =>
  new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_MEDIA', message);

/**
 * Normalises an uploaded profile photo: decodes it (validating it really is an
 * image), applies EXIF orientation, centre-crops to a square, and re-encodes it
 * as WebP. Re-encoding drops all metadata (EXIF, GPS) and any embedded payload.
 */
export async function processAvatar(data: Buffer): Promise<Buffer> {
  if (data.length === 0) throw invalidMedia();
  if (data.length > AVATAR_MAX_BYTES) {
    throw new ApiException(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'INVALID_MEDIA',
      'Image must be 5 MB or smaller',
    );
  }
  if (!detectImageFormat(data)) throw invalidMedia();
  try {
    return await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw invalidMedia('This image could not be processed');
  }
}
