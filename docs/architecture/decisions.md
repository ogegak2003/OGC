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

**Status:** Accepted as a design direction (Phase 1); protocol choice before Phase 3

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
