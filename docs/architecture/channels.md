# Community channels

Phase 4. **Community channels are not end-to-end encrypted** — OGC can read posts so it can
offer discovery, search and moderation for large audiences (ADR-032). For private,
encrypted broadcasts use an encrypted channel ([groups.md](groups.md)). Permissions:
[community-permissions.md](community-permissions.md). Moderation: ADR-035.

## Model

| Table                        | Purpose                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`                   | handle (unique, 5–32 chars), name, description, photo, visibility (`PUBLIC`/`PRIVATE`), join policy (`OPEN`/`APPROVAL`), post policy, replies on/off, `version`, member count, archive |
| `channel_members`            | role, status (`ACTIVE`/`PENDING`/`BANNED`), suspension, notification level, read mark                                                                                                  |
| `channel_posts`              | `seq`, `version`, author, idempotency key, body (≤ 4 000), reply (one level), announcement, pin, edit/delete/removal timestamps                                                        |
| `channel_post_reactions`     | the six OGC reactions                                                                                                                                                                  |
| `channel_attachments`        | server-readable media (`channel-media/<uuid>.webp` or `.bin`)                                                                                                                          |
| `channel_moderation_actions` | append-only history with reasons                                                                                                                                                       |
| `channel_post_reports`       | reports reviewed by the channel's moderators                                                                                                                                           |

Database constraints enforce one owner, handle format, non-negative counters, the reaction
set, "deleted posts have no body", "no self-replies", "only active members hold elevated
roles" and the storage-key format.

## Features

- **Discovery** — `GET /channels/discover?q=` lists public, non-archived channels by size;
  `q` (≥ 2 chars) matches name, handle and description through a trigram index. Private
  channels are never listed and answer `404` to non-members by every route.
- **Joining** — public + open: join; public + approval: request (moderators approve/reject);
  private: invitation link only (approval still applies). Banned people can't rejoin.
- **Posting** — top-level posts follow the post policy (`ADMINS` default, `MODERATORS`,
  `ALL_MEMBERS`); replies are open to active members when enabled; announcements are for owners
  and admins and notify members. Posts are idempotent on `clientPostId`. Authors edit within
  48 hours and delete at any time (text, reactions and media are erased).
- **Pins** — moderators pin up to 10 visible top-level posts.
- **Media** — images are decoded and re-encoded to WebP (≤ 2048 px, metadata stripped); other
  files are stored as uploaded and **always served as downloads** with
  `application/octet-stream` and `nosniff`. Orphaned uploads are purged after 24 hours.
- **Search in a channel** — `GET /channels/:id/posts?q=`.
- **Unread & sync** — per-member read mark; `GET /channels/:id/sync?after=<version>`.
- **Realtime** — `channel.post_created/updated/deleted/pinned`, `channel.announcement_created`,
  `channel.updated`, `channel.member_joined/left`, `channel.access_revoked` to active members'
  sockets (IDs only).
- **Moderation** — remove/restore posts with reasons, suspend, remove, ban/unban, review
  reports, approve requests; full history at `GET /channels/:id/moderation`.
- **Visibility** — owner only, `POST /channels/:id/visibility { visibility, confirm: true }`;
  the response lists the consequences; audited.
- **Archive / delete** — owner only; delete erases posts, media and memberships.

## Status

| Feature                                                                                     | Status                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| All features above (API)                                                                    | Implemented and tested (`channels.test.ts`)                                 |
| Web UI (directory, feed, threads, composer with media, settings, moderation tools)          | Implemented                                                                 |
| Mobile UI (directory, feed, threads, composer, join/leave, moderation essentials, links/QR) | Implemented; media upload and settings editing are web-only                 |
| Mentions in channel posts                                                                   | Implemented in the API (`mentions` field); not yet offered in the composers |
| Anonymous (signed-out) reading of public channels                                           | Not implemented                                                             |
