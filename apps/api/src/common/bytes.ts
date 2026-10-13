/** Decodes base64 into a standalone byte array (the type Prisma expects for `Bytes` columns). */
export function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

export function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

/** Copies any byte buffer into a standalone byte array. */
export function ownBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
