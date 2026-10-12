import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';

describe('safeNext', () => {
  it.each(['/home', '/id/OGC482731905', '/contacts?tab=1'])('allows same-site path %s', (path) => {
    expect(safeNext(path)).toBe(path);
  });

  it.each([null, '', 'https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)'])(
    'falls back to /home for %j',
    (value) => {
      expect(safeNext(value)).toBe('/home');
    },
  );
});
