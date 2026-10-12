import type { OgcId } from '@ogc/types';
import { buildOgcIdLink, formatOgcIdForDisplay } from '@ogc/validation';

export interface ShareableIdentity {
  title: string;
  text: string;
  /** https link on the web app's own origin: `/id/OGC…` (the future universal link). */
  url: string;
}

/**
 * Builds what "Share my OGC" sends. Contains only public identity data — the
 * OGC ID, display name and links — never tokens or private account data.
 */
export function shareableIdentity(
  ogcId: OgcId,
  displayName: string,
  origin: string,
): ShareableIdentity {
  return {
    title: `${displayName} on OGC`,
    text: `Add ${displayName} on OGC: ${formatOgcIdForDisplay(ogcId)}\nOpen in the app: ${buildOgcIdLink(ogcId)}`,
    url: `${origin}/id/${ogcId}`,
  };
}

/** Uses the native share sheet where available, otherwise copies to the clipboard. */
export async function shareIdentity(identity: ShareableIdentity): Promise<'shared' | 'copied'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share(identity);
      return 'shared';
    } catch (error) {
      // The user dismissed the sheet: nothing more to do.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  await navigator.clipboard.writeText(`${identity.text}\n${identity.url}`);
  return 'copied';
}
