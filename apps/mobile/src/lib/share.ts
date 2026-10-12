import type { OgcId } from '@ogc/types';
import { buildOgcIdLink, formatOgcIdForDisplay } from '@ogc/validation';
import { Share } from 'react-native';

/** Text for "Share my OGC": public identity only — never tokens or private account data. */
export function shareMessage(ogcId: OgcId, displayName: string): string {
  return `Add ${displayName} on OGC: ${formatOgcIdForDisplay(ogcId)}\n${buildOgcIdLink(ogcId)}`;
}

/** Opens the platform share sheet. */
export async function shareIdentity(ogcId: OgcId, displayName: string): Promise<void> {
  await Share.share({ title: `${displayName} on OGC`, message: shareMessage(ogcId, displayName) });
}
