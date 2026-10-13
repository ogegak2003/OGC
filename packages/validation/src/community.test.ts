import { describe, expect, it } from 'vitest';
import {
  INVITE_TOKEN_PATTERN,
  changeVisibilityRequestSchema,
  channelHandleSchema,
  channelPostRequestSchema,
  communityNameSchema,
  createChannelRequestSchema,
  createGroupRequestSchema,
  createInviteLinkRequestSchema,
  groupDescriptionSchema,
  markNotificationsReadSchema,
  notificationPreferencesSchema,
  updateGroupRequestSchema,
} from './community.js';

const uuid = '0190a8f2-6b7c-7d3e-9f10-1a2b3c4d5e6f';

describe('community validation', () => {
  it('normalises names and rejects unsafe characters', () => {
    expect(communityNameSchema.parse('  Hiking\t club  ')).toBe('Hiking club');
    expect(communityNameSchema.parse('ｆｕｌｌ')).toBe('full');
    expect(communityNameSchema.safeParse('').success).toBe(false);
    expect(communityNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(communityNameSchema.safeParse('evil‮gnp.exe').success).toBe(false);
    expect(communityNameSchema.safeParse('bell\u0007').success).toBe(false);
  });

  it('keeps line breaks in descriptions but limits them', () => {
    expect(groupDescriptionSchema.parse('a\r\n\n\n\nb')).toBe('a\n\nb');
    expect(groupDescriptionSchema.safeParse('x'.repeat(501)).success).toBe(false);
    expect(groupDescriptionSchema.safeParse('tab\u0000').success).toBe(false);
  });

  it('accepts groups and encrypted channels only', () => {
    expect(createGroupRequestSchema.parse({ name: 'G' })).toMatchObject({ kind: 'GROUP' });
    expect(createGroupRequestSchema.safeParse({ name: 'G', kind: 'DIRECT' }).success).toBe(false);
    expect(
      createGroupRequestSchema.safeParse({ name: 'G', invite: Array(32).fill('OGC482731905') })
        .success,
    ).toBe(false);
    expect(updateGroupRequestSchema.safeParse({}).success).toBe(false);
    expect(updateGroupRequestSchema.parse({ description: null })).toEqual({ description: null });
  });

  it('validates channel handles', () => {
    expect(channelHandleSchema.parse('@Night_Sky')).toBe('night_sky');
    for (const bad of ['abc', '1night', 'night sky', 'nüght', 'x'.repeat(33)]) {
      expect(channelHandleSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('defaults channels to public, open and admin posting', () => {
    expect(createChannelRequestSchema.parse({ handle: 'stars', name: 'Stars' })).toMatchObject({
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
      postPolicy: 'ADMINS',
      repliesEnabled: true,
    });
  });

  it('requires explicit confirmation to change visibility', () => {
    expect(changeVisibilityRequestSchema.safeParse({ visibility: 'PRIVATE' }).success).toBe(false);
    expect(
      changeVisibilityRequestSchema.safeParse({ visibility: 'PRIVATE', confirm: false }).success,
    ).toBe(false);
    expect(
      changeVisibilityRequestSchema.safeParse({ visibility: 'PRIVATE', confirm: true }).success,
    ).toBe(true);
  });

  it('validates posts', () => {
    expect(channelPostRequestSchema.safeParse({ clientPostId: uuid }).success).toBe(false);
    expect(channelPostRequestSchema.safeParse({ clientPostId: uuid, body: '   ' }).success).toBe(
      false,
    );
    expect(
      channelPostRequestSchema.safeParse({
        clientPostId: uuid,
        body: 'x',
        replyToId: uuid,
        announcement: true,
      }).success,
    ).toBe(false);
    expect(
      channelPostRequestSchema.safeParse({ clientPostId: uuid, attachmentIds: [uuid] }).success,
    ).toBe(true);
  });

  it('bounds invitation links', () => {
    expect(createInviteLinkRequestSchema.parse({})).toEqual({ expiresInHours: 168 });
    expect(createInviteLinkRequestSchema.safeParse({ expiresInHours: 721 }).success).toBe(false);
    expect(createInviteLinkRequestSchema.safeParse({ maxUses: 0 }).success).toBe(false);
    expect(INVITE_TOKEN_PATTERN.test(`ogc_inv_${'a'.repeat(43)}`)).toBe(true);
    expect(INVITE_TOKEN_PATTERN.test(`ogc_inv_${'a'.repeat(42)}`)).toBe(false);
  });

  it('validates notification preferences', () => {
    expect(notificationPreferencesSchema.safeParse({}).success).toBe(false);
    expect(notificationPreferencesSchema.parse({ mutedUntil: null })).toEqual({ mutedUntil: null });
    expect(notificationPreferencesSchema.safeParse({ mutedUntil: 'tomorrow' }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markNotificationsReadSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});
