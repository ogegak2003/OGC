/**
 * The community permission matrix lives in `@ogc/validation` so the apps hide
 * exactly the controls the server refuses. The API enforces it on every
 * request through these functions (docs/architecture/community-permissions.md).
 */
export {
  type CommunityKind,
  type InvitePolicy,
  type PostPolicy,
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
  rank,
} from '@ogc/validation';
