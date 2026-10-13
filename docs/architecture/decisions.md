# Architecture decision records

Short records of significant decisions: context, decision, consequences. Add a new entry
rather than editing an accepted one; mark superseded entries.

---

## ADR-001: Modular monolith

**Status:** Accepted (Phase 0)

**Context.** OGC's long-term scope is broad (messaging, media, calls, moderation…) but the
team and traffic are small today. Microservices would add network failure modes,
distributed transactions, and operational cost before they deliver value.

**Decision.** A single NestJS API with strictly bounded domain modules (see
[overview](overview.md#module-boundary-rules)).

**Consequences.** Simple deployment and refactoring now. Boundary discipline (module-owned
tables, events for side effects) is required so modules can be extracted later.

---

## ADR-002: TypeScript 6.0, not 7.0

**Status:** Accepted (Phase 0)

**Context.** TypeScript 7 (the native compiler) is the latest release, but
`typescript-eslint` — which provides our type-aware lint rules — supports
`typescript >=4.8.4 <6.1.0`.

**Decision.** Pin `typescript ~6.0.3` workspace-wide (Expo SDK 57 also uses 6.0).

**Consequences.** Full type-aware linting. Revisit when typescript-eslint supports TS 7.

---

## ADR-003: Prisma 7 stable, not the 8.0 release candidate

**Status:** Accepted (Phase 0)

**Context.** npm's `latest` tag for the `prisma` CLI points to `8.0.0-rc.*`, while
`@prisma/client`'s `latest` is `7.10.0`.

**Decision.** Use Prisma **7.10.0** (CLI and client) with the `prisma-client` generator,
ESM output, and the `@prisma/adapter-pg` driver adapter. Connection settings live in
`prisma.config.ts`.

**Consequences.** Stable, matched versions. Upgrade to 8 after its general release.

---

## ADR-004: ESM throughout

**Status:** Accepted (Phase 0)

**Context.** NestJS 12 is published as ESM only.

**Decision.** All workspaces are ES modules (`"type": "module"`, `NodeNext` resolution in
Node code), except the Expo app, which follows Expo's bundler conventions.

**Consequences.** Relative imports in Node code use explicit `.js` extensions.

---

## ADR-005: Vitest everywhere except mobile; no SWC

**Status:** Accepted (Phase 0)

**Context.** Nest dependency injection needs `emitDecoratorMetadata`. The usual Vitest
recipe uses SWC, but SWC 1.16.18's native addon refuses to load on hosts whose `C:\` drive
grants broad write permissions (as on the primary development machine). Vite 8's Oxc
transformer reads `experimentalDecorators`/`emitDecoratorMetadata` from `tsconfig.json`.

**Decision.** Vitest (Oxc transform) for API, web, and packages. Jest via `jest-expo` for the
mobile app, as Expo recommends. The `@swc/core` optional peer of `@nestjs/cli` is
installed but its install script is denied; the Nest CLI builds with `tsc`.

**Consequences.** One fewer native dependency. API end-to-end tests verify that DI works.

---

## ADR-006: Shared packages are compiled; `ui` holds design tokens only

**Status:** Accepted (Phase 0)

**Context.** Packages must be consumable by Node (API), Vite (web), and Metro (mobile).
Web and mobile have different rendering primitives (DOM vs React Native).

**Decision.** Shared packages compile to ESM + type declarations in `dist/` (Turborepo
builds them before dependants). `@ogc/ui` contains platform-neutral **design tokens** with
no React dependency; each client builds its own components from them.

**Consequences.** One source of truth for the visual identity; component libraries per
platform can be added later (e.g. `packages/ui-web`) without changing tokens.

---

## ADR-007: One React version across the monorepo

**Status:** Accepted (Phase 0)

**Context.** Expo SDK 57 pins React 19.2.3; React 19.3 is available.

**Decision.** Web also uses React 19.2.3.

**Consequences.** No duplicate React type conflicts. Web upgrades React with Expo SDK
upgrades.

---

## ADR-008: Random 9-digit OGC IDs

**Status:** Proposed — owner approval requested for the length (Phase 1)

**Context.** The owner approved random, non-sequential public IDs with 6-digit examples
(`OGC482731`) and allowed the length to change if technically justified. A 6-digit space
holds only 900 000 IDs: OGC would run out below one million users, and long before that,
random allocation would collide constantly and most guesses would hit real accounts
(enumeration).

**Decision.** `OGC` + 9 digits with a non-zero first digit (900 million IDs), drawn
uniformly with `crypto.randomInt`; uniqueness enforced by a database unique index with
retry on collision; format and immutability enforced by the database. Displayed in groups
of three (`OGC 482 731 905`); input is normalised from that form.

**Consequences.** At 10 million users, a random guess hits an account ~1% of the time.
Growth beyond ~100 million users would add a digit: validators would accept both lengths,
and existing IDs never change.

---

## ADR-009: Opaque server-side sessions with rotating refresh tokens

**Status:** Accepted (Phase 1)

**Context.** Self-contained JWT access tokens cannot be revoked before expiry without a
server-side denylist, and they invite long lifetimes. OGC needs immediate revocation
(logout, suspension, device removal) and per-device sessions.

**Decision.** Random 256-bit opaque tokens; only SHA-256 hashes are stored. 15-minute access
tokens are checked against the `sessions` table on every request. Refresh tokens rotate on
every use; the refresh token embeds its session ID so reuse of a superseded token is
detected and revokes the session. Sessions have a 30-day absolute lifetime.

**Consequences.** One indexed lookup per request (cacheable later). Revocation is
immediate. Concurrent refreshes by one client must be serialised (both clients do this).

---

## ADR-010: Browser sessions use HttpOnly cookies; native apps use bearer tokens

**Status:** Accepted (Phase 1)

**Context.** Tokens in browser JavaScript (localStorage, memory) are exposed to any XSS.
Cookies need CSRF protection. Native apps have secure platform storage but no cookie jar
semantics worth relying on.

**Decision.** Browsers send `X-OGC-Client: web` and receive tokens only as `HttpOnly`,
`SameSite=Strict` cookies (`__Host-` access cookie; `__Secure-` refresh cookie scoped to
`/api/v1/auth`; `Secure` required in production). Cookie-authenticated state-changing
requests must carry that header: cross-site pages cannot add it without a CORS preflight,
which the origin allowlist rejects. Native apps receive tokens in the response body, keep
the access token in memory and the refresh token in `expo-secure-store`
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`).

**Consequences.** No token is ever readable by web JavaScript. The web app is served
same-origin with the API (Vite proxy in development, nginx in production).

---

## ADR-011: Registration never reveals whether an email is registered

**Status:** Accepted (Phase 1)

**Context.** "Email already in use" errors let anyone test which addresses have accounts.

**Decision.** `POST /auth/register` returns the same `202` for new and existing emails and
always performs the Argon2 hash. Existing owners receive an "account exists" email instead.
Accounts start `PENDING_VERIFICATION` and no session is issued at registration; the user
verifies via an emailed link, then signs in. Pending accounts may sign in but can only reach
verification-related endpoints. Login failures are generic; account state is revealed only
after a correct password. Email delivery is a port (`EmailSender`) — development uses a
local file outbox; no provider is wired yet.

**Consequences.** Slightly longer onboarding (check email, then sign in), in exchange for
no account enumeration through registration or login.

---

## ADR-012: Messaging is designed for end-to-end encryption

**Status:** Accepted (Phase 1); protocol chosen in Phase 3 — MLS, see ADR-024

**Context.** OGC's value depends on private communication. Retrofitting E2E encryption into
a server-readable messaging system is very hard; the identity and device model must allow it
from the start.

**Decision.** One-to-one and group message content will be end-to-end encrypted between
**devices**, not accounts (multi-device, Signal-style: per-device identity keys and pre-keys;
messages encrypted once per recipient device; group messaging via sender keys or MLS —
RFC 9420 — to be evaluated). The server stores and relays ciphertext and public keys only.
Therefore:

- `devices` is the anchor for per-device public keys; each device has its own keys and
  sessions and can be revoked independently.
- The OGC ID is never derived from key material; keys can rotate without changing identity.
- Account credentials (password) are separate from message keys; resetting a password does
  not grant access to message history.
- Key backup/recovery, safety-number verification, and multi-device history sync are
  explicit product decisions for Phase 3.

**Consequences.** Server-side message search, moderation of message content, and push
notification previews must work without plaintext (client-side search, user reports that
include the reported content, generic push text). Channels (public broadcast) may be
exempt — to be decided.

---

## ADR-013: QR codes encode only a public identity link

**Status:** Accepted (Phase 1); link domain pending approval

**Decision.** QR codes contain `ogc://id/<OGC ID>` and nothing else — no tokens, keys,
credentials, or private account data. Scanning resolves the ID server-side (Phase 2). When a
public web domain is approved, the base becomes an https universal/app link
(e.g. `https://<domain>/id/OGC…`) so scans also work without the app installed.

---

## ADR-014: Argon2id via `@node-rs/argon2`

**Status:** Accepted (Phase 1)

**Context.** Node 24 ships `crypto.argon2`, but at "release candidate" stability.

**Decision.** Use `@node-rs/argon2` (prebuilt binaries, no install scripts) with OWASP's
minimum Argon2id parameters (m = 19 MiB, t = 2, p = 1), behind a `PasswordHasher` class.
Hashes are PHC strings; outdated parameters are upgraded at the next successful sign-in.

**Consequences.** Can switch to the built-in implementation once it is stable, without
changing stored hashes.

---

## ADR-015: No usernames for now

**Status:** Accepted (Phase 2)

**Context.** Many messaging apps have `@usernames`. OGC already has a unique, human-readable,
shareable identifier: the OGC ID.

**Decision.** Do not introduce usernames in Phase 2. Display names are free-form and **not
unique**; the OGC ID is the canonical identity.

**Consequences.** No name-squatting, no impersonation through look-alike handles, no
handle-change history to manage, and no new enumeration surface (handles are guessable;
random OGC IDs are not). If memorable handles are wanted later, they must come with
uniqueness under Unicode confusable normalisation, reserved and brand names, change limits,
and moderation — a product decision first.

---

## ADR-016: Contacts, requests and blocks are separate relational models

**Status:** Accepted (Phase 2)

**Decision.** `contact_requests` (state machine with sender, timestamps and a partial unique
index for one pending request per pair), `contacts` (one row per direction), and `blocks`
(independent of contact state). All relationship rules live in `RelationshipService`.

**Consequences.** Messaging can answer "are they contacts / is either blocked / who asked"
with single indexed lookups. Blocking can never be confused with "declined". Per-direction
contact rows cost twice the rows but give O(1) membership checks and per-owner metadata.

---

## ADR-017: Profile photos: object storage, re-encoding and authorised delivery

**Status:** Accepted (Phase 2)

**Decision.** Binary media never goes into PostgreSQL. An `ObjectStorage` port with a
development-only local adapter (production: S3-compatible, to be chosen). Uploads are
detected by content, decoded with a pixel limit, and re-encoded to 512×512 WebP with
`sharp`; keys are server-generated UUIDs. Photos are served through the API so each request
is authorised against the owner's privacy settings, rather than through public URLs.

**Consequences.** Metadata and payloads are stripped; no path or filename handling; old
photos are deleted. Serving through the API costs bandwidth — a CDN with signed, short-lived
URLs can replace it later without changing clients' `avatarUrl` contract.

---

## ADR-018: Lightweight mobile navigation

**Status:** Accepted (Phase 2)

**Decision.** A small in-house stack navigator (with Android back handling) instead of Expo
Router or React Navigation for now. Screens use only `useNavigation()`.

**Consequences.** No new native dependencies this phase. Revisit when the app needs tabs,
native transitions, or route-level deep linking (Phase 3 messaging is the likely trigger).

---

## ADR-019: Authenticate before rate limiting; limit signed-in traffic per account

**Status:** Accepted (Phase 2) — amends the Phase 1 guard order

**Decision.** `AuthGuard` runs before `OgcThrottlerGuard`, which keys signed-in requests by
account and anonymous ones by IP. Sensitive endpoints (discovery, requests, reports) set
per-account limits.

**Consequences.** An enumerator cannot evade discovery limits by rotating IPs; they would
need many verified accounts. Anonymous floods against protected endpoints are rejected by
authentication (a cheap indexed lookup) rather than throttled first.

---

## ADR-020: Identity links: custom scheme today, universal links next

**Status:** Accepted (Phase 2); domain pending approval

**Decision.** QR codes encode `ogc://id/<OGC ID>` (opens the app). The web app serves the
same identity at `/id/<OGC ID>` and "Share my OGC" sends that https link. Once an official
domain is approved: host `/.well-known/apple-app-site-association` and `assetlinks.json`,
add associated domains / intent filters to the app, and switch the QR payload to
`https://<domain>/id/<OGC ID>` so scans work with or without the app. The parser keeps
accepting `ogc://` links indefinitely.

---

## ADR-021: Staff roles as the first authorization layer

**Status:** Accepted (Phase 2)

**Decision.** A `staff_roles` table (`MODERATOR`, `ADMIN`) loaded into `AuthContext` from
the database on every request, and `@RequireStaffRole(...)` on staff endpoints. Roles are
granted only by operators (database/CLI); no API grants roles and client-supplied role
claims are ignored.

**Consequences.** Report access is restricted today. The full admin console, role
management UI, and MFA for staff come in Phase 9.

---

## ADR-006 amendment (Phase 2)

`@ogc/ui` now also holds **platform-neutral visual primitives** that both clients must render
identically — currently `qrSvgPath()`. It still contains no React or platform code.

---

## ADR-022: Messaging domain — DIRECT conversations, server-visible metadata only

**Status:** Accepted (Phase 3)

**Context.** One-to-one messaging must ship now without blocking groups and channels later,
and the server must not need message content.

**Decision.**

- A `conversations` table with a `type` (only `DIRECT` today) and participants in
  `conversation_participants`. DIRECT conversations have a unique ordered-pair key, so a pair
  has exactly one conversation; a trigger admits only those two users. Groups will add types
  and participant roles without changing messages.
- Conversations can be started **with contacts only** (spam control); existing
  conversations continue if someone is removed from contacts (blocking is the tool to stop
  contact). Message requests from non-contacts are a later product decision.
- `messages` store MLS ciphertext and routing metadata only. Edits keep metadata, not old
  ciphertext. "Delete for everyone" erases ciphertext, reactions and attachments but keeps
  the record and an audit event. "Delete for me" is a per-user hide.
- Edit and delete-for-everyone windows: 48 hours.
- Reactions use a fixed set of six types and are **visible to the server** (to enforce
  uniqueness and the allowed set). Encrypting reactions was rejected for now: it would move
  the uniqueness rule to clients for little privacy gain over a six-value set.
- When the recipient has blocked the sender, messages are accepted and **withheld** (never
  delivered), so the block is not revealed.

**Consequences.** The server enforces authorization, ordering and integrity rules in the
database; it learns metadata (who, when, sizes, reaction types) but not content.

---

## ADR-023: Socket.IO for realtime, with a versioned, closed event contract

**Status:** Accepted (Phase 3)

**Decision.** Socket.IO 4.8 via `@nestjs/platform-socket.io` at `/api/realtime`, namespace
`/v1` as the protocol version: mature reconnection, acknowledgements, rooms, a React Native
client and a Redis adapter for horizontal scaling. Plain `ws` was rejected (reconnection,
rooms and fan-out would be rebuilt by hand). Durable operations (send, edit, receipts) stay on
REST, so an acknowledgement means persistence; realtime only notifies. The event contract is
typed in `@ogc/types`; unknown client events disconnect the socket. Sockets authenticate with
the same sessions as REST (bearer, or cookie plus an Origin allowlist), and close at token
expiry and on revocation. Details: [realtime.md](realtime.md).

**Consequences.** One transport for later phases (groups, call signalling). Browsers that
fall back to long-polling need sticky sessions behind a load balancer.

---

## ADR-024: End-to-end encryption with MLS (RFC 9420) via `ts-mls`

**Status:** Accepted (Phase 3) — **production use requires an independent audit**

**Context.** OGC needs E2E encryption across browsers, Node and React Native (Hermes), with
multiple devices per person, forward secrecy and post-compromise security, and a path to
groups. Custom cryptography is ruled out.

**Decision.** MLS (RFC 9420), ciphersuite 0x0003 (X25519, ChaCha20-Poly1305, SHA-256,
Ed25519), implemented with `ts-mls` 1.6.4 (MIT, pure TypeScript, passes the MLS interop
vectors) over the audited `@noble/*` primitives and `hpke-js`. Each device is an MLS leaf with
its own Ed25519 identity key; one MLS group per conversation; commits are public messages so
the server can enforce membership policy without decrypting; new devices join by Welcome or
external commit. Libsignal (AGPL, no web or React Native build), community Signal ports (GPL,
stale) and vodozemac (no standalone JS/React Native binding) were evaluated and rejected;
OpenMLS is the alternative if WASM/React Native bindings are built later. Full evaluation and
trust model: [encryption.md](encryption.md).

**Consequences.** One protocol for direct and group messaging. `ts-mls` is unaudited: an
independent review of the library and of OGC's integration is a production prerequisite.
Hermes needs a narrow, tested HMAC/HKDF SubtleCrypto shim. New devices cannot read earlier
history until encrypted history transfer exists.

---

## ADR-025: Per-conversation change counter for synchronization

**Status:** Accepted (Phase 3)

**Decision.** Each conversation has a `version` counter incremented under a row lock inside
every change's transaction; messages (position `seq`, last change `version`), MLS commits and
per-user hides carry versions. Clients keep a cursor per conversation and pull
`/sync?after=cursor`; a changes feed (`updated_at` with a 10 s safety lag) finds conversations
to sync. Rejected: a global sequence (not commit-ordered, so late commits create gaps) and a
per-user event log (one write per recipient, heavy for groups). Details: [sync.md](sync.md).

**Consequences.** Simple, gap-free sync with indexed range queries; writes to one
conversation are serialized (fine for DIRECT and moderate groups; revisit for very large
groups or channels).

---

## ADR-026: Presence and typing are ephemeral

**Status:** Accepted (Phase 3)

**Decision.** Typing and presence never touch PostgreSQL. Presence lives in Redis sorted
sets with expiring entries (in memory without Redis); typing is relayed directly and expires
after 8 s. Both are visible only between conversation partners with no block in either
direction, are rate-limited, and are documented as approximate. There is no "last seen".

**Consequences.** No write amplification; presence may lag by up to the heartbeat interval
after a crash. Privacy settings for presence and read receipts come later.

---

## ADR-027: Attachments are encrypted on the device

**Status:** Accepted (Phase 3)

**Decision.** Each file is encrypted with a fresh random 256-bit key using
XChaCha20-Poly1305 (`@noble/ciphers`); the key, nonce, ciphertext digest, name and type travel
inside the MLS-encrypted message. The server stores ciphertext under server-generated keys,
enforces per-kind size limits, serves it only to participants as an opaque download, and
deletes unattached uploads after 24 hours. Recipients verify digest and size and decide how to
display content from the decrypted bytes, never from declared types. Server-side content
scanning is therefore impossible by design; moderation relies on user reports.

**Consequences.** No plaintext media on OGC servers. Media goes through the API (direct
uploads with short-lived signed URLs are planned with the object-storage provider). Whole-file
encryption in memory limits sizes to 25 MiB until chunked encryption is added.

---

## ADR-028: Push notifications carry no message content

**Status:** Accepted (Phase 3) — backend implemented; mobile token registration pending

**Decision.** Notifications say only "New message" plus the conversation ID; third-party
push services never see content. Tokens are bound to the authenticated device, moved if
another device registers the same token, and deleted at logout. Devices with a live socket are
skipped. Providers sit behind a port: `disabled`, `outbox` (development) and `expo` (Expo push
HTTP API). Rich, decrypted notifications (notification service extensions) are a later step.

---

## ADR-029: Configurable per-account rate limits, shared through Redis

**Status:** Accepted (Phase 3)

**Decision.** Messaging limits (sends, conversation creation, attachments, reactions, edits,
deletes, receipts, sync, E2E operations, typing, presence, socket connections) are environment
variables with sensible defaults, applied per account (and per IP for socket connections, with
the trusted-proxy rule). With `REDIS_URL` the throttler storage is an atomic Redis script
shared by all instances; Redis is **required in production**.

**Consequences.** Closes the Phase 2 "per-instance rate limits" gap for production; local
development and tests stay single-instance in memory unless they opt in.

---

## ADR-030: Message search runs on the device

**Status:** Accepted (Phase 3)

**Decision.** No server-side message search (the server cannot read messages). Each device
searches its own sealed, decrypted store. Searchable/encrypted indexes on the server were
rejected: they leak access patterns and add complex cryptography for little benefit at this
stage.

**Consequences.** Search covers only messages on that device (not history from before it
joined); it is a linear scan for now — an encrypted local index is a later optimisation.

---

## ADR-031: Groups and encrypted channels are conversations with roles

**Status:** Accepted (Phase 4)

**Decision.** Private groups and private encrypted channels are `conversations` of type
`GROUP` / `CHANNEL` on the same messaging and MLS engine as DIRECT conversations — no second
engine. Participants get a `role` (`OWNER` | `ADMIN` | `MODERATOR` | `MEMBER`); exactly one
owner is enforced by a partial unique index. Details, photo and policies live in
`group_profiles`. People join only by accepting a personal invitation (sent to contacts) or
through an invitation link; nobody is added silently. Members are capped at **32** (ADR-033).
Membership changes take the conversation row lock and append a `conversation_events` row at
the next version, so the timeline syncs in order with messages. A member's history starts when
they join (`visible_from_version`). The permission matrix is one pure module
(`community-permissions.ts` in `@ogc/validation`) used by the API to enforce and by the apps
to hide controls ([community-permissions.md](community-permissions.md)).

**Consequences.** All Phase 3 guarantees (idempotent sends, receipts, sync, attachments)
apply unchanged. Group metadata (name, description, photo, membership, roles) is visible to
OGC; content is not.

---

## ADR-032: Community channels are server-readable and never switch encryption mode

**Status:** Accepted (Phase 4)

**Decision.** Large, discoverable channels are a separate module (`channels`,
`channel_posts`…) whose content OGC can read — needed for discovery, search, moderation and
audiences beyond MLS's practical size. They are labelled "not end-to-end encrypted" in every
response (`endToEndEncrypted: false`) and screen. A channel never switches between encrypted
and server-readable; people who need encryption create an encrypted channel (ADR-031).
Visibility (public ⇄ private) changes only by the owner with `confirm: true`, after the
consequences are shown; the change is audited and logged in the moderation history.

**Consequences.** Two clearly separated privacy models instead of one ambiguous one. Public
channels are readable by any signed-in account (not by anonymous web visitors).

---

## ADR-033: MLS membership updates for groups

**Status:** Accepted (Phase 4)

**Context.** Removing a member must cut off their cryptographic access; the server must not be
able to inject devices; MLS commit cost grows with the tree.

**Decision.**

- Measured with `ts-mls` on Node: 16 leaves ≈ 0.5 s per add commit and 6 KB GroupInfo;
  128 leaves ≈ 10 s and 48 KB; 256 leaves ≈ 25 s and 96 KB. Groups are therefore capped at
  32 members and **4 devices per member** (the newest active ones) — at most **128 leaves**;
  the delivery service also rejects any tree above 128 leaves.
- A group's device directory lists the eligible devices of _current_ members, plus recent
  former members' keys as inactive, so devices that were offline can still verify the commits
  that added and then removed them.
- On every accepted commit the DS records whose devices are in the tree
  (`mls_member_user_ids`). While it contains anyone who is no longer a participant, new
  messages and edits are refused with `409 MLS_MEMBERSHIP_STALE`; the client commits the
  removal and retries. The check is repeated under the conversation row lock, so it cannot
  race a removal. A removed member's devices therefore never receive keys for anything sent
  after the removal — tested with real cryptography, including against a stolen copy of the
  old group state.
- Any member device may commit adds (eligible devices of participants, with claimed key
  packages) and removals of devices that are no longer eligible. Commits are compare-and-set
  per epoch; stale and replayed commits are rejected.
- A device that cannot verify a historical commit drops its state and re-joins by external
  commit (allowed only for eligible devices); messages in between show as unavailable there.

**Consequences.** Sub-second commits for typical groups. A member's 5th and later devices
cannot take part in a group (documented limitation). New members cannot read history from
before they joined.

---

## ADR-034: Invitation tokens

**Status:** Accepted (Phase 4)

**Decision.** Invitation links carry `ogc_inv_` + 256 random bits (base64url). Only the
SHA-256 is stored (full-entropy input, so a fast hash is appropriate); the token is shown once,
at creation. Links expire (1 hour – 30 days, default 7 days), may be limited in uses (consumed
atomically with the join) and can be revoked. Every failure — unknown, malformed, revoked,
expired, used up — gives the same `404 INVITATION_INVALID`. Links never bypass a target's
rules (capacity, archive state, bans, approval). Tokens travel in request bodies only; the web
link is `<origin>/join#token=…`, so the token stays in the URL fragment (never sent to a
server or logged). QR codes encode that link and nothing else. Personal invitations expire
after 14 days; an hourly sweep marks them expired and tells the inviter once.

**Consequences.** A database leak does not leak usable links. Anyone holding a valid link can
ask to join until it expires or is revoked; owners are told so when they create it.

---

## ADR-035: Moderation model

**Status:** Accepted (Phase 4)

**Decision.** In community channels, moderators remove/restore posts with reasons, pin,
review reports, approve join requests and suspend/remove/ban _members_; admins and owners do
the same over lower roles and manage settings and roles. Every action is appended to
`channel_moderation_actions` with its reason and to the audit log. Removed posts stay
reviewable by moderators and show a placeholder to others; an author's own deletion erases
the content and media. Bans block reading, rejoining and invitation links, and take effect at
once on open sockets. In encrypted groups, owners and admins (and moderators in encrypted
channels) may remove lower-ranked members' messages for everyone — recorded as a
`MESSAGE_REMOVED` timeline event without content. Reports from encrypted conversations contain
only text the reporter explicitly chose to disclose, go to OGC staff
(`/admin/conversation-reports`), and are audited without that text. Channel post reports go to
the channel's own moderators, and the reporter is told the outcome.

**Consequences.** No component can decrypt E2E content for moderation.

---

## ADR-036: Community synchronization and notifications

**Status:** Accepted (Phase 4)

**Decision.** Groups reuse conversation sync, with a new `event` item for membership and
settings changes. Community channels have their own change counter (`channels.version`):
every post, edit, reaction, pin and removal takes the next version, and
`GET /channels/:id/sync?after=` returns posts changed after a cursor. Realtime channel events
carry IDs only and go to the socket room `channel:<id>` of active members (joined on connect,
updated on membership changes); clients fetch personalised views through REST. In-app
notifications are stored once per recipient (`notifications`, unique `dedupe_key`), delivered
in realtime and pushed with a **fixed generic text** per type (the push payload type admits
nothing else) to offline devices, honouring each member's level (`ALL` / `MENTIONS` / `NONE`)
and mute. Mentions in encrypted groups are declared by the sender's device (OGC IDs beside
the ciphertext); the server never parses message text.

**Consequences.** Retries and multiple devices never duplicate a notification. Announcement
fan-out is bounded (10 000 members per announcement); larger audiences rely on realtime and
unread counts.
