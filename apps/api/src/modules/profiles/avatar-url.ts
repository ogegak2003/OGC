import type { OgcId } from '@ogc/types';

/**
 * Public URL of a profile photo. Photos are served through the API so every
 * request is authorised against the owner's privacy settings; storage keys and
 * file paths are never exposed. The `v` parameter changes with each upload, so
 * clients can cache aggressively.
 */
export function avatarUrlFor(ogcId: OgcId, avatarKey: string | null): string | null {
  if (!avatarKey) return null;
  const version = /([0-9a-f]{8})-/.exec(avatarKey)?.[1] ?? '0';
  return `/api/v1/profiles/${ogcId}/avatar?v=${version}`;
}
