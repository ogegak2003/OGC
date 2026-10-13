/**
 * The community permission matrix (docs/architecture/community-permissions.md) as pure
 * functions, shared by the API (which enforces it) and the apps (which only use it to
 * hide controls the server would refuse anyway). Never trust a client-supplied role.
 */
export type Role = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
export type PostPolicy = 'ALL_MEMBERS' | 'MODERATORS' | 'ADMINS';
export type InvitePolicy = 'ALL_MEMBERS' | 'ADMINS';
export type CommunityKind = 'GROUP' | 'CHANNEL' | 'COMMUNITY_CHANNEL';

const RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MODERATOR: 1, MEMBER: 0 };

export function rank(role: Role): number {
  return RANK[role];
}

export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

export function canPost(role: Role, policy: PostPolicy): boolean {
  switch (policy) {
    case 'ALL_MEMBERS':
      return true;
    case 'MODERATORS':
      return RANK[role] >= RANK.MODERATOR;
    case 'ADMINS':
      return RANK[role] >= RANK.ADMIN;
  }
}

export function canEditDetails(role: Role): boolean {
  return RANK[role] >= RANK.ADMIN;
}

export function canInvite(role: Role, policy: InvitePolicy): boolean {
  return policy === 'ALL_MEMBERS' || RANK[role] >= RANK.ADMIN;
}

export function canManageInviteLinks(role: Role): boolean {
  return RANK[role] >= RANK.ADMIN;
}

export function canModerate(role: Role): boolean {
  return RANK[role] >= RANK.MODERATOR;
}

/** Remove, ban or suspend: owners and admins act on lower roles; moderators on members only. */
export function canActOnMember(actor: Role, target: Role, kind: CommunityKind): boolean {
  if (kind !== 'COMMUNITY_CHANNEL' && actor === 'MODERATOR') return false;
  if (actor === 'MODERATOR') return target === 'MEMBER';
  return RANK[actor] >= RANK.ADMIN && outranks(actor, target);
}

/** Roles that may exist in a community kind (moderators are a channel role). */
export function assignableRoles(kind: CommunityKind): Role[] {
  return kind === 'GROUP' ? ['ADMIN', 'MEMBER'] : ['ADMIN', 'MODERATOR', 'MEMBER'];
}

/**
 * Role changes: never the owner role (that is a transfer), never one's own role. Owners may
 * set any other role; admins may set moderator or member for people below them.
 */
export function canAssignRole(
  actor: Role,
  target: Role,
  next: Role,
  kind: CommunityKind,
  self: boolean,
): boolean {
  if (self || next === 'OWNER' || target === 'OWNER') return false;
  if (!assignableRoles(kind).includes(next)) return false;
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN')
    return outranks(actor, target) && (next === 'MODERATOR' || next === 'MEMBER');
  return false;
}

export function canTransferOwnership(role: Role): boolean {
  return role === 'OWNER';
}

export function canArchiveOrDelete(role: Role): boolean {
  return role === 'OWNER';
}

export function canChangePolicies(role: Role): boolean {
  return RANK[role] >= RANK.ADMIN;
}
