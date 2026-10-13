import { describe, expect, it } from 'vitest';
import { parseOgcId } from './ogc-id.js';
import { buildInviteUrl, buildOgcIdLink, parseInviteToken, parseOgcIdLink } from './ogc-link.js';

const id = parseOgcId('OGC482731905');

describe('OGC identity links', () => {
  it('builds a link that contains only the public OGC ID', () => {
    expect(buildOgcIdLink(id)).toBe('ogc://id/OGC482731905');
  });

  it('supports an https base for universal links', () => {
    const link = buildOgcIdLink(id, 'https://example.test/id/');
    expect(link).toBe('https://example.test/id/OGC482731905');
    expect(parseOgcIdLink(link, 'https://example.test/id/')).toBe(id);
  });

  it('round-trips', () => {
    expect(parseOgcIdLink(buildOgcIdLink(id))).toBe(id);
  });

  it.each([
    'ogc://id/OGC123',
    'ogc://id/OGC482731905/extra',
    'ogc://id/OGC482731905?token=abc',
    'ogc://id/OGC482731905#x',
    'https://evil.test/id/OGC482731905',
    'ogc://profile/OGC482731905',
  ])('rejects %s', (link) => {
    expect(parseOgcIdLink(link)).toBeUndefined();
  });
});

describe('invitation links', () => {
  const token = `ogc_inv_${'Ab9_-'.repeat(8)}abc`;

  it('puts the token in the fragment only', () => {
    const url = buildInviteUrl('https://ogc.example/', token);
    expect(url).toBe(`https://ogc.example/join#token=${token}`);
    expect(url.split('#')[0]).not.toContain(token);
  });

  it('parses links and bare tokens, and nothing else', () => {
    expect(parseInviteToken(buildInviteUrl('https://ogc.example', token))).toBe(token);
    expect(parseInviteToken(`  ${token} `)).toBe(token);
    expect(parseInviteToken('https://ogc.example/join#token=ogc_inv_short')).toBeUndefined();
    expect(parseInviteToken(`${token}x`)).toBeUndefined();
    expect(parseInviteToken('OGC482731905')).toBeUndefined();
  });
});
