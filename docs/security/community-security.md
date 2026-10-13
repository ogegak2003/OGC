# Community security

Threats and controls for groups, encrypted channels, community channels, invitations,
moderation and notifications (Phase 4). Complements
[messaging-security.md](messaging-security.md) and [social-safety.md](social-safety.md).

## Authorization

- Every route checks membership and role on the server
  ([permission matrix](../architecture/community-permissions.md)); clients only hide controls.
- Non-members get the **same 404** as for unknown IDs for groups, private channels, posts in
  them, media, invitations and links — no existence oracle, no IDOR.
- Role changes cannot target oneself or the owner role; ownership moves only by transfer under
  a row lock, and the database guarantees exactly one owner.
- Membership changes, capacity checks and link-use consumption run under row locks or atomic
  conditional updates (tested with concurrent requests: 33 accepts → exactly 32 members; 8
  joins on a 3-use link → exactly 3).

## Invitation links

- 256-bit random tokens (`ogc_inv_…`), only SHA-256 stored, shown once; expiry ≤ 30 days,
  optional use limits, revocation, audit events for creation and revocation (never the token).
- Identical answers for every invalid state; strict per-account rate limit
  (`RATE_LIMIT_INVITE_LINK_JOIN_PER_HOUR`) on previews and joins.
- Tokens only in request bodies and URL fragments (`/join#token=`), never in paths, query
  strings or logs. QR codes encode only that link.
- Links never bypass bans, approval, capacity or archive state.

## Encrypted content

- The server never receives plaintext of group messages (asserted in tests by scanning every
  stored column and every request body for the plaintext).
- Reports disclose text only when the reporter turns it on; the audit log records that a
  report was made, never the text.
- Mentions are OGC IDs chosen by the sender's device; the server never parses content.

## Community channels

- Clearly labelled as not end-to-end encrypted; visibility changes need explicit owner
  confirmation and are audited.
- Text is rendered as plain text only (never HTML). Images are decoded and re-encoded (EXIF/GPS
  removed, decompression-bomb limit); other files are served only as downloads with
  `application/octet-stream`, `Content-Disposition: attachment` and `nosniff`. Error responses
  are always JSON, even on file routes.
- Search queries escape SQL `LIKE` wildcards; discovery never returns private channels.
- Moderation actions require a strictly higher role (moderators act on members only), are
  logged with reasons and audited; bans take effect immediately on open sockets.

## Notifications

- Payloads hold IDs and public names only. Push text is fixed per type (enforced by the
  TypeScript type of the push payload), so names and content never reach Apple, Google or Expo.
- Deduplicated per recipient by a unique key; honours levels and mutes.

## Abuse protection

Per-account limits (environment variables, Redis-shared): community creation, management,
invitations, link joins, channel posts, moderation, discovery, reports and notification reads
(see [environment.md](../development/environment.md)). Blocked people can't be invited by the
person they blocked or who blocked them (invitations require a contact relationship with no
block).

## Known gaps

- No independent audit of the MLS integration (production prerequisite).
- No automated content scanning in community channels; moderation is human and per channel.
- Staff tooling for conversation reports is a read-only queue (no actions yet).
- Announcement fan-out is bounded at 10 000 recipients per post.
