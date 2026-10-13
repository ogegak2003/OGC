import type { Credential } from 'ts-mls';
import { fromUtf8, utf8 } from './bytes.js';

/**
 * Every MLS leaf is one OGC device. Its basic credential binds the leaf to
 * the account's public OGC ID and the server-issued device key ID:
 *
 *     ogc-device/v1/<OGC ID>/<device key ID>
 *
 * The server only accepts key packages and joins whose credential matches the
 * device that uploads them, and clients cross-check every group member against
 * the published device directory (see docs/architecture/encryption.md).
 */
export interface DeviceCredential {
  ogcId: string;
  deviceKeyId: string;
}

const PREFIX = 'ogc-device/v1/';
const PATTERN =
  /^ogc-device\/v1\/(OGC[1-9]\d{8})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export const DEVICE_KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function deviceCredential({ ogcId, deviceKeyId }: DeviceCredential): Credential {
  const identity = `${PREFIX}${ogcId}/${deviceKeyId}`;
  if (!PATTERN.test(identity)) throw new Error('Invalid device credential');
  return { credentialType: 'basic', identity: utf8(identity) };
}

/** Parses a credential, returning undefined for anything that is not a valid OGC device. */
export function parseDeviceCredential(credential: Credential): DeviceCredential | undefined {
  if (credential.credentialType !== 'basic') return undefined;
  let identity: string;
  try {
    identity = fromUtf8(credential.identity);
  } catch {
    return undefined;
  }
  const match = PATTERN.exec(identity);
  if (!match?.[1] || !match[2]) return undefined;
  return { ogcId: match[1], deviceKeyId: match[2] };
}
