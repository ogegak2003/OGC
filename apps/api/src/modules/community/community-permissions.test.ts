import { describe, expect, it } from 'vitest';
import {
  type Role,
  assignableRoles,
  canActOnMember,
  canArchiveOrDelete,
  canAssignRole,
  canChangePolicies,
  canEditDetails,
  canInvite,
  canManageInviteLinks,
  canModerate,
  canPost,
  canTransferOwnership,
  outranks,
} from './community-permissions.js';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER'];

/** The matrix in docs/architecture/community-permissions.md, cell by cell. */
describe('community permission matrix', () => {
  it('orders roles strictly', () => {
    expect(outranks('OWNER', 'ADMIN')).toBe(true);
    expect(outranks('ADMIN', 'MODERATOR')).toBe(true);
    expect(outranks('MODERATOR', 'MEMBER')).toBe(true);
    for (const role of ROLES) expect(outranks(role, role)).toBe(false);
    expect(outranks('MEMBER', 'OWNER')).toBe(false);
  });

  it('applies post policies', () => {
    const table = Object.fromEntries(
      (['ALL_MEMBERS', 'MODERATORS', 'ADMINS'] as const).map((policy) => [
        policy,
        ROLES.filter((role) => canPost(role, policy)),
      ]),
    );
    expect(table).toEqual({
      ALL_MEMBERS: ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER'],
      MODERATORS: ['OWNER', 'ADMIN', 'MODERATOR'],
      ADMINS: ['OWNER', 'ADMIN'],
    });
  });

  it('limits details, policies and links to owners and admins', () => {
    for (const check of [canEditDetails, canChangePolicies, canManageInviteLinks]) {
      expect(ROLES.filter((r) => check(r))).toEqual(['OWNER', 'ADMIN']);
    }
    expect(ROLES.filter((r) => canModerate(r))).toEqual(['OWNER', 'ADMIN', 'MODERATOR']);
    expect(ROLES.filter((r) => canTransferOwnership(r))).toEqual(['OWNER']);
    expect(ROLES.filter((r) => canArchiveOrDelete(r))).toEqual(['OWNER']);
  });

  it('applies invite policies', () => {
    expect(ROLES.filter((r) => canInvite(r, 'ADMINS'))).toEqual(['OWNER', 'ADMIN']);
    expect(ROLES.filter((r) => canInvite(r, 'ALL_MEMBERS'))).toEqual(ROLES);
  });

  it('lets owners and admins act on lower roles, moderators on members of community channels', () => {
    expect(canActOnMember('OWNER', 'ADMIN', 'GROUP')).toBe(true);
    expect(canActOnMember('ADMIN', 'MEMBER', 'GROUP')).toBe(true);
    expect(canActOnMember('ADMIN', 'ADMIN', 'GROUP')).toBe(false);
    expect(canActOnMember('ADMIN', 'OWNER', 'COMMUNITY_CHANNEL')).toBe(false);
    expect(canActOnMember('MODERATOR', 'MEMBER', 'COMMUNITY_CHANNEL')).toBe(true);
    expect(canActOnMember('MODERATOR', 'MODERATOR', 'COMMUNITY_CHANNEL')).toBe(false);
    expect(canActOnMember('MODERATOR', 'MEMBER', 'GROUP')).toBe(false);
    expect(canActOnMember('MODERATOR', 'MEMBER', 'CHANNEL')).toBe(false);
    for (const target of ROLES)
      expect(canActOnMember('MEMBER', target, 'COMMUNITY_CHANNEL')).toBe(false);
  });

  it('assigns roles without self-promotion or owner changes', () => {
    expect(assignableRoles('GROUP')).toEqual(['ADMIN', 'MEMBER']);
    expect(assignableRoles('COMMUNITY_CHANNEL')).toEqual(['ADMIN', 'MODERATOR', 'MEMBER']);
    expect(canAssignRole('OWNER', 'MEMBER', 'ADMIN', 'GROUP', false)).toBe(true);
    expect(canAssignRole('OWNER', 'MEMBER', 'MODERATOR', 'GROUP', false)).toBe(false);
    expect(canAssignRole('OWNER', 'MEMBER', 'OWNER', 'GROUP', false)).toBe(false);
    expect(canAssignRole('OWNER', 'OWNER', 'ADMIN', 'GROUP', true)).toBe(false);
    expect(canAssignRole('ADMIN', 'MEMBER', 'ADMIN', 'COMMUNITY_CHANNEL', false)).toBe(false);
    expect(canAssignRole('ADMIN', 'MEMBER', 'MODERATOR', 'COMMUNITY_CHANNEL', false)).toBe(true);
    expect(canAssignRole('ADMIN', 'ADMIN', 'MEMBER', 'COMMUNITY_CHANNEL', false)).toBe(false);
    expect(canAssignRole('ADMIN', 'MEMBER', 'MEMBER', 'COMMUNITY_CHANNEL', true)).toBe(false);
    expect(canAssignRole('MODERATOR', 'MEMBER', 'MODERATOR', 'COMMUNITY_CHANNEL', false)).toBe(
      false,
    );
    expect(canAssignRole('MEMBER', 'MEMBER', 'ADMIN', 'GROUP', false)).toBe(false);
  });
});
