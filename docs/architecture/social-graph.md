# Profiles, contacts and identity discovery

Phase 2 builds the social layer on top of the Phase 1 identity: profiles, privacy,
contacts, blocking, reporting, discovery by OGC ID, and identity sharing (QR and links).
Data details: [data-model.md](data-model.md). Security rationale:
[docs/security/social-safety.md](../security/social-safety.md).

## Module map

| Module (`apps/api/src/modules/`) | Responsibility                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `relationships`                  | **`RelationshipService`** — the single source of truth for visibility and relationship state |
| `profiles`                       | Own profile, public profiles, exact OGC ID discovery, profile photos                         |
| `contacts`                       | Contact requests and the contact list                                                        |
| `blocks`                         | Blocking and unblocking                                                                      |
| `reports`                        | User reports and the staff-only report queue                                                 |
| `storage`                        | `ObjectStorage` port for binary media (local dev adapter today)                              |
| `common/events`                  | `DomainEventBus` — in-process events for future realtime and notifications                   |

Every endpoint takes the acting user **only** from `@CurrentAuth()`; no route accepts a user
ID, and other people are addressed only by their public OGC ID.

## Profile model

`profiles` (1:1 with `users`) holds the public presentation plus the privacy settings that
govern it:

| Field                  | Rules                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| `displayName`          | 1–64 characters, NFKC-normalised, whitespace collapsed. **Not unique.** |
| `bio`                  | Optional, ≤ 280 characters, line breaks allowed, no control characters. |
| `avatarKey`            | Server-generated storage key of the processed photo (never a filename). |
| `profileVisibility`    | `CONTACTS` (default) or `EVERYONE` — who sees bio, photo, member-since. |
| `discoverable`         | `true` (default) — can non-contacts look the account up by OGC ID / QR. |
| `contactRequestPolicy` | `EVERYONE` (default) or `NOBODY`.                                       |

No phone number, address, birth date, location or government ID is collected.
**Usernames are deliberately not introduced** ([ADR-015](decisions.md#adr-015-no-usernames-for-now)).

### What a viewer can see

| Viewer                             | OGC ID & name | Bio, photo, member since | Found by lookup?                           |
| ---------------------------------- | ------------- | ------------------------ | ------------------------------------------ |
| The owner                          | ✓             | ✓                        | ✓                                          |
| A contact                          | ✓             | ✓                        | ✓ (even if not discoverable)               |
| Anyone else, visibility `EVERYONE` | ✓             | ✓                        | if discoverable                            |
| Anyone else, visibility `CONTACTS` | ✓             | –                        | if discoverable                            |
| Someone the owner blocked          | –             | –                        | **No** — identical 404 to a nonexistent ID |
| Someone the viewer blocked         | ✓             | –                        | ✓ (to allow unblocking)                    |

Only ACTIVE accounts are ever visible. Pending, suspended and deactivated accounts answer
like nonexistent ones.

## Relationship model

`RelationshipService.stateBetween(viewer, target)` runs three indexed queries in parallel
(blocks both ways, contact row, pending request) and returns the viewer's state:

| State              | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `SELF`             | The viewer's own account                                    |
| `BLOCKED`          | **The viewer** blocked the target (never "blocked by them") |
| `CONTACT`          | Accepted contacts                                           |
| `OUTGOING_REQUEST` | The viewer's request is pending                             |
| `INCOMING_REQUEST` | The target's request to the viewer is pending               |
| `NONE`             | No relationship                                             |

Public profile responses also carry `canSendContactRequest` and `pendingRequestId`, so
clients never re-derive rules. Future messaging and calls must call
`RelationshipService.isBlockedEitherWay()` before any interaction.

### Contacts

Two tables ([ADR-016](decisions.md#adr-016-contacts-requests-and-blocks-are-separate-relational-models)):

- `contact_requests` — `PENDING → ACCEPTED | DECLINED | CANCELLED`, with who sent it and
  when it was answered. A partial unique index allows **one pending request per pair, in
  either direction**, so duplicates are impossible even under concurrency.
- `contacts` — one row per direction (`owner → contact`), created together in the accept
  transaction. Per-direction rows make "my contacts" a single indexed range scan and leave
  room for per-owner data later (nickname, muted, favourite).

Rules:

| Action                   | Who                           | Notes                                                                                                         |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Send request             | Anyone who can see the target | Not to self; not if blocked either way; respects `NOBODY`; a **mutual** request becomes a contact immediately |
| Accept / decline         | Recipient only                | Others get 404 (no confirmation the request exists)                                                           |
| Cancel                   | Sender only                   | Others get 404                                                                                                |
| Remove contact           | Either contact                | Removes both directions                                                                                       |
| Re-request after decline | Sender                        | Only after a 7-day cooldown                                                                                   |

### Blocking

`blocks(blocker, blocked)` is **independent of contact state**. Blocking, in one transaction:
creates the block (idempotent), removes the contact in both directions, and cancels pending
requests in both directions. Effects today:

- The blocked person cannot find, view, or send requests to the blocker — and sees the same
  404 as for a nonexistent account, so the block is not revealed.
- The blocker sees the person as `BLOCKED` (so they can unblock) with details hidden.
- Accepting an old request across a block is refused.

Unblocking removes only the block; it does not restore the contact. Blocking will also
gate messaging and calls once they exist — it does **not** yet cover interactions that do
not exist.

### Reports

`POST /reports/users` stores `user_reports(reporter, reported, category, description,
status)`. Categories are a controlled list (`SPAM`, `HARASSMENT`, `IMPERSONATION`,
`INAPPROPRIATE_CONTENT`, `SCAM_OR_FRAUD`, `OTHER`); clients cannot set status or actions.
Reporting works even if the reported person blocked the reporter; unknown IDs and duplicate
open reports get the same `202` without storing anything. Staff read the queue at
`GET /admin/reports` ([ADR-021](decisions.md#adr-021-staff-roles-as-the-first-authorization-layer)).

Future moderation workflow (Phase 9): triage queue by category and volume → review with
reporter-supplied context → actions (warn, restrict, suspend) recorded as audited moderation
events → `RESOLVED`/`DISMISSED` → optional reporter notification. Moderators will see only
what is needed; E2E-encrypted message content is visible only if a reporter includes it.

## Discovery

Implemented: **exact OGC ID lookup only** — `GET /discovery/ogc/:ogcId` accepts what people
type (`ogc 482 731 905`) and returns a `PublicProfile`. There is no fuzzy or global search,
no phone-number matching, and no contact-book upload.

Protections against enumeration: 9-digit random IDs (900M space), per-**account** rate limit
(20/min, independent of IP), only ACTIVE + discoverable accounts, and identical 404s for
nonexistent, hidden, inactive and "blocked you" accounts.

Possible future methods (not implemented): username handles (if ever adopted), invitation
links with expiry, QR scanning in the mobile app, contacts-of-contacts suggestions (opt-in),
verified business identities. Phone-number discovery is out of scope.

## Identity sharing: QR codes and links

| Form                  | Example                                | Status                                                                                                                      |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Custom scheme         | `ogc://id/OGC482731905`                | QR payload; opens the mobile app                                                                                            |
| Web route             | `https://<web origin>/id/OGC482731905` | Implemented in the web app; shared via "Share my OGC"                                                                       |
| Universal / App Links | `https://<official domain>/id/OGC…`    | Planned once a domain is approved ([ADR-020](decisions.md#adr-020-identity-links-custom-scheme-today-universal-links-next)) |

QR codes and links contain **only** the public OGC ID — never tokens, keys, internal IDs or
private data. Parsing (`parseOgcIdLink`) rejects anything else (extra path, query or fragment).
Opening a link shows the profile; it **never** adds a contact by itself. The QR matrix is
generated once in `@ogc/ui` (`qrSvgPath`) and rendered by web (SVG) and mobile
(`react-native-svg`) identically.

## Profile photos

([ADR-017](decisions.md#adr-017-profile-photos-object-storage-re-encoding-and-authorised-delivery))

1. `POST /profile/avatar` (multipart field `avatar`, ≤ 5 MB, kept in memory — nothing written
   to disk before validation; the client filename is ignored).
2. Type detected from the file's bytes (JPEG/PNG/WebP only); executables, SVG, HTML rejected.
3. Decoded with a 40-megapixel limit, EXIF-rotated, centre-cropped and **re-encoded to
   512×512 WebP** — stripping metadata (including GPS) and any embedded payload.
4. Stored under a fresh server key `avatars/<uuid>.webp` through `ObjectStorage`; the old
   object is deleted after the database switches over.
5. Served only through `GET /profiles/:ogcId/avatar`, which applies the same privacy rules as
   the profile. `avatarUrl` includes a version parameter for cache-busting; no storage paths
   are exposed.

Storage drivers: `disabled` (default; uploads return `503 MEDIA_UNAVAILABLE`) and `local`
(development only). Production will add an S3-compatible adapter behind the same port.

## Pagination

Lists (`/contacts`, `/contacts/requests/*`, `/blocks`, `/admin/reports`) use **keyset
pagination** over UUIDv7 row IDs, newest first: `?limit=1–100` (default 50) and an opaque
`?cursor=` (base64url row ID, validated). Each page fetches `limit + 1` rows to know if more
exist. No offsets, no unbounded loads, stable under concurrent inserts, and served by
`(owner, id)` indexes.

## Events

`DomainEventBus` publishes, after commit: `contact.request.sent`, `.accepted`, `.declined`,
`.cancelled`, `contact.removed`, `user.blocked`, `user.unblocked`, `profile.updated`. Nothing
consumes them yet except tests. Future use:

| Event                      | Realtime (Phase 3)               | Notification (Phase 7)              |
| -------------------------- | -------------------------------- | ----------------------------------- |
| `contact.request.sent`     | Update recipient's request badge | Push "New contact request"          |
| `contact.request.accepted` | Update both contact lists        | Push "<name> accepted"              |
| `contact.removed`          | Remove from the other list       | — (silent)                          |
| `user.blocked`/`unblocked` | Hide/refresh conversations       | — (never notify the blocked person) |
| `profile.updated`          | Refresh cached profile cards     | —                                   |

No WebSockets were added in this phase; clients re-fetch after their own actions.

## API endpoints (all under `/api/v1`, authenticated, ACTIVE accounts only)

| Method & path                         | Purpose                                    | Limit (per account) |
| ------------------------------------- | ------------------------------------------ | ------------------- |
| `GET /profile`                        | Own profile and privacy settings           | global              |
| `PATCH /profile`                      | Update display name, bio, privacy          | 30 / hour           |
| `POST /profile/avatar`                | Upload photo (multipart `avatar`)          | 10 / hour           |
| `DELETE /profile/avatar`              | Remove photo                               | global              |
| `GET /profiles/:ogcId`                | Public profile with relationship           | 60 / min            |
| `GET /profiles/:ogcId/avatar`         | Profile photo (privacy-checked)            | 300 / min           |
| `GET /discovery/ogc/:ogcId`           | Exact OGC ID lookup (human input)          | **20 / min**        |
| `GET /contacts`                       | Contacts (paginated)                       | 120 / min           |
| `POST /contacts/requests`             | Send request `{ ogcId }`                   | 30 / hour           |
| `GET /contacts/requests/incoming`     | Pending incoming (paginated)               | 120 / min           |
| `GET /contacts/requests/outgoing`     | Pending outgoing (paginated)               | 120 / min           |
| `POST /contacts/requests/:id/accept`  | Accept (recipient only)                    | 120 / min           |
| `POST /contacts/requests/:id/decline` | Decline (recipient only)                   | 120 / min           |
| `DELETE /contacts/requests/:id`       | Cancel (sender only)                       | 120 / min           |
| `DELETE /contacts/:ogcId`             | Remove contact                             | 120 / min           |
| `GET /blocks`                         | Blocked people (paginated)                 | global              |
| `POST /blocks/:ogcId`                 | Block (idempotent)                         | 60 / hour           |
| `DELETE /blocks/:ogcId`               | Unblock (idempotent)                       | 60 / hour           |
| `POST /reports/users`                 | Report `{ ogcId, category, description? }` | 10 / hour           |
| `GET /admin/reports`                  | Report queue — **MODERATOR / ADMIN only**  | global              |
