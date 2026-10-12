import { describe, expect, it } from 'vitest';
import {
  bioSchema,
  contactRequestSchema,
  ogcIdInputSchema,
  pageQuerySchema,
  reportUserRequestSchema,
  updateProfileRequestSchema,
} from './social.js';

describe('ogcIdInputSchema', () => {
  it.each(['OGC482731905', 'ogc 482 731 905', ' OGC-482-731-905 '])('normalises %j', (value) => {
    expect(ogcIdInputSchema.parse(value)).toBe('OGC482731905');
  });

  it.each(['', 'OGC123', 'OGC000000001', 'hello', 'x'.repeat(40)])('rejects %j', (value) => {
    expect(ogcIdInputSchema.safeParse(value).success).toBe(false);
  });
});

describe('bioSchema', () => {
  it('keeps single line breaks, collapses long runs and trims', () => {
    expect(bioSchema.parse('  Builder.\r\n\r\n\r\n\r\nTraveller.  ')).toBe(
      'Builder.\n\nTraveller.',
    );
  });

  it('rejects over-long bios and control characters', () => {
    expect(bioSchema.safeParse('x'.repeat(281)).success).toBe(false);
    expect(bioSchema.safeParse('bell\u0007').success).toBe(false);
    expect(bioSchema.safeParse('tab\there').success).toBe(false);
  });
});

describe('updateProfileRequestSchema', () => {
  it('accepts partial updates', () => {
    expect(updateProfileRequestSchema.parse({ bio: 'Hello' })).toEqual({ bio: 'Hello' });
    expect(updateProfileRequestSchema.parse({ bio: null })).toEqual({ bio: null });
    expect(updateProfileRequestSchema.parse({ privacy: { discoverable: false } }).privacy).toEqual({
      discoverable: false,
    });
  });

  it('rejects empty updates and unknown fields (mass assignment)', () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ privacy: {} }).success).toBe(false);
    for (const extra of [{ ogcId: 'OGC111111111' }, { userId: 'x' }, { avatarKey: 'a' }]) {
      expect(updateProfileRequestSchema.safeParse({ bio: 'x', ...extra }).success).toBe(false);
    }
    expect(
      updateProfileRequestSchema.safeParse({ privacy: { profileVisibility: 'PUBLIC' } }).success,
    ).toBe(false);
  });
});

describe('contactRequestSchema', () => {
  it('normalises the OGC ID and rejects other fields', () => {
    expect(contactRequestSchema.parse({ ogcId: 'ogc 482 731 905' })).toEqual({
      ogcId: 'OGC482731905',
    });
    expect(
      contactRequestSchema.safeParse({ ogcId: 'OGC482731905', status: 'ACCEPTED' }).success,
    ).toBe(false);
  });
});

describe('reportUserRequestSchema', () => {
  it('accepts a controlled category and optional description', () => {
    expect(
      reportUserRequestSchema.parse({
        ogcId: 'OGC482731905',
        category: 'SPAM',
        description: ' x ',
      }),
    ).toEqual({ ogcId: 'OGC482731905', category: 'SPAM', description: 'x' });
  });

  it('rejects unknown categories, moderation actions and long descriptions', () => {
    const base = { ogcId: 'OGC482731905', category: 'SPAM' };
    expect(reportUserRequestSchema.safeParse({ ...base, category: 'BAN_USER' }).success).toBe(
      false,
    );
    expect(reportUserRequestSchema.safeParse({ ...base, action: 'SUSPEND' }).success).toBe(false);
    expect(
      reportUserRequestSchema.safeParse({ ...base, description: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });
});

describe('pageQuerySchema', () => {
  it('defaults and bounds the page size', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ limit: '10', cursor: 'abc_-1' })).toEqual({
      limit: 10,
      cursor: 'abc_-1',
    });
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ cursor: '../etc' }).success).toBe(false);
  });
});
