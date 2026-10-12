/**
 * Validates a post-login destination. Only same-site paths are allowed, so a
 * crafted `?next=` link cannot redirect users to another site (open redirect).
 */
export function safeNext(value: string | null): string {
  // Reject protocol-relative ("//evil.test") and backslash ("/\evil.test") forms browsers treat as hosts.
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/home';
  return value;
}
