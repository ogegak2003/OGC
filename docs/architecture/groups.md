# Groups and private encrypted channels

Phase 4. Decisions: ADR-031 (model and roles), ADR-033 (MLS membership), ADR-034
(invitations), ADR-036 (sync and notifications). Permissions:
[community-permissions.md](community-permissions.md). Encryption details:
[community-encryption.md](community-encryption.md).

## What they are

|                     | Group                                                                                 | Private encrypted channel           |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| Conversation type   | `GROUP`                                                                               | `CHANNEL`                           |
| Members             | up to 32                                                                              | up to 32                            |
| Default post policy | everyone (`ALL_MEMBERS`)                                                              | admins (`ADMINS`) — broadcast style |
| Roles               | owner, admin, member                                                                  | owner, admin, moderator, member     |
| Content             | end-to-end encrypted (MLS)                                                            | end-to-end encrypted (MLS)          |
| Visible to OGC      | name, description, photo, members, roles, policies, timestamps, sizes, reaction types | same                                |

Both reuse the Phase 3 messaging engine (`@ogc/messaging`) and API (`/conversations/:id/…`)
for messages, attachments, voice notes, replies, reactions, edits (48 h), deletes, receipts,
typing and sync. Group-only features live under `/api/v1/groups`.

## Lifecycle

- **Create** — `POST /groups` `{ kind, name, description?, invite?[] }`. The creator is the
  owner; `invite` sends personal invitations to contacts (non-contacts are skipped silently).
- **Invite** — `POST /groups/:id/invitations` (invite policy: admins by default). Invitations
  expire after 14 days. Invitees see them at `GET /invitations` and accept/decline; inviters or
  admins revoke with `DELETE /invitations/:id`.
- **Invitation links / QR** — `POST /groups/:id/invite-links` (owners and admins); see
  [community-security.md](../security/community-security.md#invitation-links).
- **Join** — accepting or using a link runs under the conversation row lock: capacity (32) and
  archive state are checked, a `MEMBER_JOINED` event is appended, and the member's history
  starts there (`visible_from_version`). Existing members' devices then add the newcomer's
  devices to the MLS group.
- **Roles** — `PUT /groups/:id/members/:ogcId/role`; ownership moves only with
  `POST /groups/:id/transfer` (the owner becomes an admin; one owner at all times).
- **Remove / leave** — `DELETE /groups/:id/members/:ogcId`, `POST /groups/:id/leave`. The owner
  must transfer ownership first, unless they are the last member (the group is then deleted).
  The removed person's devices erase the conversation; other devices commit the MLS removal
  before anyone can send again.
- **Archive** — owner only; read-only for everyone until restored.
- **Delete** — owner only; messages, MLS state, attachments, events and the photo are erased
  from OGC, and members' devices erase their copies. Exports or screenshots can't be recalled.

## Timeline and history

`conversation_events` (append-only, versioned with messages) records `CREATED`,
`MEMBER_JOINED/LEFT/REMOVED`, `ROLE_CHANGED`, `OWNERSHIP_TRANSFERRED`, `DETAILS_UPDATED`,
`MESSAGE_REMOVED`, `ARCHIVED/UNARCHIVED` with actor and subject (shown by OGC ID) and
non-sensitive details (e.g. the new role). Sync returns them as `{ type: 'event' }` items;
devices keep the last 500 locally and show them inline.

## Receipts, blocking and safety

- Read/delivered marks in groups are "by everyone": the lowest mark among the other members.
- Messages from someone you blocked stay visible in a group (a group is shared with others);
  their reactions are hidden from you, typing is not exchanged across a block, and pushes from
  them are not sent to you. Presence is shared only through DIRECT conversations.
- Reports: any member can report a message, choosing whether to disclose its decrypted text.
- Admins/owners (and moderators in encrypted channels) can remove lower-ranked members'
  messages for everyone; the removal is recorded without content.

## Notifications

Per-member level (`ALL` / `MENTIONS` / `NONE`) and mute (`PUT /conversations/:id/notifications`).
Mentions are found on the sending device (`@Name` or OGC ID) and sent as OGC IDs beside the
ciphertext. In-app notifications cover invitations, members added/removed, role and details
changes and mentions; pushes use fixed generic text.

## Status

| Feature                                                                                          | Status                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Create, invite, accept/decline/revoke, links/QR, roles, transfer, remove, leave, archive, delete | Implemented (API, web, mobile)                  |
| E2EE messages, attachments, voice, replies, reactions, edits, deletes, receipts, sync            | Implemented (shared engine)                     |
| Cryptographic removal cut-off, stale/replayed commit rejection                                   | Implemented and tested with real MLS            |
| Group photo, name, policies editing                                                              | Implemented on web; mobile shows them read-only |
| History for new members                                                                          | Not provided by design (they cannot decrypt it) |
| Groups larger than 32 / more than 4 devices per member                                           | Not supported (ADR-033)                         |
