# Community permissions

The single source of truth for who may do what in private groups, private encrypted
channels and community channels. The rules are pure functions in
`packages/validation/src/community-permissions.ts`, enforced by the API on every request and
tested through direct API calls
(`apps/api/test/groups.test.ts`, `channels.test.ts`). Clients only hide controls the server
would refuse anyway. Decision: ADR-031.

Roles: **O** owner (exactly one), **A** administrator, **M** moderator (channels only),
**U** member/subscriber. "Lower role" means strictly lower in O > A > M > U.

## Private groups and private encrypted channels (end-to-end encrypted)

| Action                               | O                                                | A                                | M (encrypted channels) | U                                                                                   |
| ------------------------------------ | ------------------------------------------------ | -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| Read and react                       | ✓                                                | ✓                                | ✓                      | ✓                                                                                   |
| Post (send messages)                 | ✓                                                | per post policy                  | per post policy        | per post policy (`ALL_MEMBERS` default for groups, `ADMINS` for encrypted channels) |
| Edit / delete own messages (48 h)    | ✓                                                | ✓                                | ✓                      | ✓                                                                                   |
| Delete others' messages for everyone | ✓                                                | ✓                                | ✓                      | —                                                                                   |
| Edit name, description, photo        | ✓                                                | ✓                                | —                      | —                                                                                   |
| Change post and invite policies      | ✓                                                | ✓                                | —                      | —                                                                                   |
| Invite people (personal invitations) | ✓                                                | ✓                                | ✓ (if policy allows)   | if invite policy is `ALL_MEMBERS`                                                   |
| Create / revoke invitation links     | ✓                                                | ✓                                | —                      | —                                                                                   |
| Revoke a personal invitation         | ✓                                                | ✓                                | own                    | own                                                                                 |
| Remove members                       | any                                              | lower roles only                 | —                      | —                                                                                   |
| Assign roles                         | any role except owner                            | moderator/member, to lower roles | —                      | —                                                                                   |
| Transfer ownership                   | ✓                                                | —                                | —                      | —                                                                                   |
| Archive / unarchive, delete          | ✓                                                | —                                | —                      | —                                                                                   |
| Leave                                | after transferring ownership (or as last member) | ✓                                | ✓                      | ✓                                                                                   |

Nobody can change their own role, and the owner role moves only through a transfer.

## Community channels (server-readable, not end-to-end encrypted)

| Action                                  | O                                                         | A                                | M            | U (member)                          | Non-member                                                            |
| --------------------------------------- | --------------------------------------------------------- | -------------------------------- | ------------ | ----------------------------------- | --------------------------------------------------------------------- |
| Find in discovery / search              | public channels                                           |                                  |              |                                     | ✓ (public only)                                                       |
| Read posts                              | ✓                                                         | ✓                                | ✓            | ✓                                   | public channels only                                                  |
| Join                                    | —                                                         | —                                | —            | —                                   | public+open: join; public+approval: request; private: invitation link |
| Post top-level                          | per post policy (`ADMINS` / `MODERATORS` / `ALL_MEMBERS`) |                                  |              |                                     | —                                                                     |
| Announcement posts                      | ✓                                                         | ✓                                | —            | —                                   | —                                                                     |
| Reply (discussion), react               | ✓                                                         | ✓                                | ✓            | ✓ if replies enabled, not suspended | —                                                                     |
| Edit own posts (48 h), delete own posts | ✓                                                         | ✓                                | ✓            | ✓                                   | —                                                                     |
| Pin / unpin                             | ✓                                                         | ✓                                | ✓            | —                                   | —                                                                     |
| Remove / restore posts (with reason)    | ✓                                                         | ✓                                | ✓            | —                                   | —                                                                     |
| Review reports                          | ✓                                                         | ✓                                | ✓            | —                                   | —                                                                     |
| Approve / reject join requests          | ✓                                                         | ✓                                | ✓            | —                                   | —                                                                     |
| Suspend posting, remove, ban, unban     | lower roles                                               | lower roles                      | members only | —                                   | —                                                                     |
| Assign roles                            | any except owner                                          | moderator/member, to lower roles | —            | —                                   | —                                                                     |
| Manage invitation links                 | ✓                                                         | ✓                                | —            | —                                   | —                                                                     |
| Edit details, join/post/reply policies  | ✓                                                         | ✓                                | —            | —                                   | —                                                                     |
| Change visibility (public ⇄ private)    | ✓ (explicit confirmation)                                 | —                                | —            | —                                   | —                                                                     |
| Transfer ownership, archive, delete     | ✓                                                         | —                                | —            | —                                   | —                                                                     |
| Report a post                           | ✓                                                         | ✓                                | ✓            | ✓                                   | public channels                                                       |

Banned people cannot read private channels, cannot rejoin (also not through invitation
links), and stop receiving events immediately. Suspended members can read but not post,
reply or react until the suspension ends.

Bans also block reading public channels while they last. In encrypted channels, moderators
can remove other members’ messages for everyone but have no other extra powers; groups have
no moderator role.

## Status

| Area                                   | Status                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Server enforcement of every rule above | Implemented (`groups.test.ts`, `channels.test.ts`, unit tests)                      |
| Web controls for all rules             | Implemented                                                                         |
| Mobile controls                        | Partial — group name/photo/policy editing and channel settings editing are web-only |
