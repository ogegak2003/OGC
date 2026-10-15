import { describe, expect, it } from 'vitest';
// Read as text by Vite (?raw): the file nginx serves the headers from.
import conf from '../../../infrastructure/docker/nginx/security-headers.conf?raw';

/*
 * The production web container's security headers (infrastructure/docker/nginx). They are only
 * served by nginx, never by the Vite dev server, so a mismatch with what the app needs (e.g.
 * the camera for video calls) would otherwise go unnoticed until production.
 */

function header(name: string): string {
  const match = new RegExp(`add_header ${name} "([^"]*)" always;`).exec(conf);
  if (!match?.[1]) throw new Error(`${name} missing`);
  return match[1];
}

describe('production security headers', () => {
  it('allows camera and microphone for this origin only (voice and video calls)', () => {
    const policy = header('Permissions-Policy');
    expect(policy).toContain('camera=(self)');
    expect(policy).toContain('microphone=(self)');
    expect(policy).toContain('geolocation=()');
  });

  it('keeps a strict content security policy', () => {
    const csp = header('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sends the other hardening headers', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
