import { describe, expect, it } from 'vitest';
import { isSameHostOrigin } from './io-adapter.js';

describe('isSameHostOrigin', () => {
  it('matches the origin native WebSocket stacks derive from the socket URL', () => {
    expect(isSameHostOrigin('http://10.0.2.2:3000', '10.0.2.2:3000')).toBe(true);
    expect(isSameHostOrigin('https://api.ogc.example', 'api.ogc.example')).toBe(true);
    expect(isSameHostOrigin('https://API.ogc.example', 'Api.Ogc.Example')).toBe(true);
  });

  it('rejects other hosts, other ports and malformed values', () => {
    expect(isSameHostOrigin('https://evil.example', 'api.ogc.example')).toBe(false);
    expect(isSameHostOrigin('https://api.ogc.example.evil.example', 'api.ogc.example')).toBe(false);
    expect(isSameHostOrigin('http://10.0.2.2:5173', '10.0.2.2:3000')).toBe(false);
    expect(isSameHostOrigin('null', 'api.ogc.example')).toBe(false);
    expect(isSameHostOrigin('https://api.ogc.example', undefined)).toBe(false);
  });
});
