import type { DirectoryDevice, LocalDevice } from './mls.js';
import { generateSigningKeyPair } from './mls.js';

/** Test-only helpers (excluded from the build). */
export async function makeDevice(ogcId: string): Promise<LocalDevice> {
  return { ogcId, deviceKeyId: crypto.randomUUID(), signing: await generateSigningKeyPair() };
}

export function directoryOf(...devices: LocalDevice[]): DirectoryDevice[] {
  return devices.map(({ ogcId, deviceKeyId, signing }) => ({
    ogcId,
    deviceKeyId,
    signaturePublicKey: signing.publicKey,
  }));
}
