import type { OgcId } from '@ogc/types';
import { normalizeOgcId } from './ogc-id.js';

/**
 * OGC identity links — the payload of OGC QR codes.
 *
 * A link carries **only** the public OGC ID. It must never contain tokens,
 * credentials, keys, or private account data. Scanning it starts a future
 * profile/contact flow that resolves the ID server-side.
 *
 * The default base is the mobile app's custom scheme; once a public web domain
 * is approved it becomes an https universal link (see ADR-013).
 */
export const DEFAULT_OGC_LINK_BASE = 'ogc://id/';

export function buildOgcIdLink(id: OgcId, base: string = DEFAULT_OGC_LINK_BASE): string {
  return `${base}${id}`;
}

/** Extracts the OGC ID from an identity link, or `undefined` if it is not one. */
export function parseOgcIdLink(
  link: string,
  base: string = DEFAULT_OGC_LINK_BASE,
): OgcId | undefined {
  if (!link.startsWith(base)) return undefined;
  const rest = link.slice(base.length);
  if (rest.includes('/') || rest.includes('?') || rest.includes('#')) return undefined;
  return normalizeOgcId(rest);
}

/**
 * Invitation links (ADR-034): `<origin>/join#token=ogc_inv_…`. The token sits in
 * the URL fragment, which browsers never send to servers (so it stays out of
 * access logs and Referer headers). The link contains no IDs, keys or content —
 * only a revocable, expiring capability to ask to join.
 */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/join#token=${token}`;
}

/** Extracts an invitation token from a pasted link or a bare token. */
export function parseInviteToken(input: string): string | undefined {
  const match = /(?:^|[#?&]token=|^)(ogc_inv_[A-Za-z0-9_-]{43})(?:$|&)/.exec(input.trim());
  return match?.[1];
}
