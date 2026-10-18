/**
 * End-to-end encryption needs the browser's Web Crypto API, which browsers only provide on
 * secure pages: HTTPS, or `localhost` on the same computer. A page opened over plain HTTP at a
 * network address (for example a phone visiting a development computer) has no Web Crypto,
 * so secure messaging cannot start there — and must say so rather than fail silently.
 */
export const INSECURE_CONTEXT_ERROR =
  'This page was opened over an insecure connection, so this browser cannot encrypt messages. Open OGC over HTTPS (or at localhost on this computer).';

/** True when the browser offers what end-to-end encryption needs. */
export function canEncryptHere(
  scope: {
    isSecureContext?: boolean;
    crypto?: { subtle?: unknown };
  } = globalThis,
): boolean {
  return scope.isSecureContext !== false && Boolean(scope.crypto?.subtle);
}
