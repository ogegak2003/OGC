# Phase 8 security and privacy review

**Date:** 2026-10-15 · **Scope:** the code in this repository (API, web, mobile, shared
packages, Docker/nginx configuration) · **Method:** an internal review of the implementation by
the development team, plus automated tests against a local PostgreSQL and Redis.

> This is **not** an independent audit or a penetration test. No external party has reviewed
> OGC's cryptography or infrastructure. Section 7 says what should be reviewed independently
> before production.

## 1. Executive summary

The foundations held up. Authentication uses hashed opaque tokens, refresh rotation with reuse
detection, Argon2id and lockout. Authorization denies by default and scopes access to
participants, with identical 404s. Message and attachment content is end-to-end encrypted with
MLS, and the server stores ciphertext only. Push notifications are generic by default, and
rate limits are shared through Redis. No vulnerability was found that exposes message content
or crosses accounts.

The review confirmed four defects or gaps worth fixing now. Three are fixed, with regression
tests:

| #    | Finding                                                                 | Severity | Status                                                                          |
| ---- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| F-01 | A lost or stolen device could not be signed out; no password change     | High     | **Fixed** (API, web, mobile, tests)                                             |
| F-02 | Production `Permissions-Policy` blocked camera and microphone (calls)   | Medium   | **Fixed** (header, regression test)                                             |
| F-03 | No key-change warning and no persisted "verified" state                 | Medium   | **Fixed** for direct conversations (TOFU)                                       |
| F-04 | No account recovery (password reset)                                    | Medium   | **Fixed in Phase 9** (email reset; history not recoverable by design)           |
| F-05 | Push token can be taken over by anyone who knows another phone's token  | Low      | Accepted (theoretical; documented)                                              |
| F-06 | A suspended account's open sockets live until access-token expiry       | Low      | **Fixed in Phase 9** (immediate revocation; 30 s socket re-check)               |
| F-07 | No purge of expired sessions or audit retention; backups undocumented   | Low      | **Fixed in Phase 9** (retention job, backup scripts); scheduling is operational |
| F-08 | Dependency advisories in mobile developer tooling                       | Low      | Accepted (dev-only paths; gate passes)                                          |
| F-09 | Security documentation out of date (throttler store, key-change status) | Info     | **Fixed**                                                                       |

The main remaining risks are:

- `ts-mls` has not been audited, and neither has OGC's use of it;
- calls are protected by DTLS-SRTP but are **not** end-to-end authenticated like messages;
- there is no account recovery;
- the mobile crypto and call paths have not been verified on physical devices.

### Phase 10 update (2026-10-15): deployment readiness

- **New finding (fixed, medium): weak or placeholder production secrets.** Production
  startup accepted any database or Redis password, including the example values. It now
  refuses missing, short or placeholder secrets (database, Redis, SMTP, metrics, TURN) and
  requires TLS to PostgreSQL and Redis unless a single-host private network is declared
  (`env.schema.test.ts`).
- **New finding (fixed, low): Redis ran as root** in both Compose stacks (it was started
  through `sh -c`, which bypasses the image's privilege drop). It now runs as `redis`.
- **New finding (fixed, low): readiness** ignored Redis and half-applied migrations, and did
  not change during shutdown. It now covers all three (`health.controller.test.ts`, the
  platform tests and the production stack check).
- **Deployment.** `docker-compose.prod.yml` and the TLS edge were added, along with
  build-context and production-stack checks. See
  [deployment.md](../operations/deployment.md) and
  [production-readiness.md](../operations/production-readiness.md). No server, domain, TLS
  certificate, SMTP, object storage or push provider has been configured.

### Phase 9 update (2026-10-15)

- **F-04:** password reset by email is implemented:
  - [account-recovery.md](account-recovery.md);
  - API tests in `password-reset.test.ts` (16) and `senders.test.ts` (4);
  - web (6) and mobile (4) interface tests.
- **F-06:** staff-only suspension revokes all sessions at once, and open sockets re-check their
  session and account status every 30 seconds (`account-suspension.test.ts`, 6).
- **F-07:** a bounded, advisory-locked retention job honours preservation holds; audit deletion
  is limited by the database ([data-retention.md](../operations/data-retention.md),
  `retention.test.ts`, 8).
- **Backups:** encrypted backup and restore scripts, verified locally
  ([backup-and-restore.md](../operations/backup-and-restore.md)).
- **Readiness:** what remains unconfigured is listed in
  [production-readiness.md](../operations/production-readiness.md).

- **New finding (fixed, medium): Docker build context.** `.dockerignore` did not exclude the
  native Android project, a local `.toolchain` folder (about 14 GB together with Android build
  output) or the development `.dev-outbox` and `.dev-storage` directories. Both Dockerfiles
  `COPY . .` in the build stage, and the `migrate` image is built from it, so development emails
  with verification and reset links could have been baked into that image. These paths and
  backup and key files are now ignored. The context went from more than 13 GB to 3.35 MB, and the
  rebuilt migrate image was checked to contain neither directory.

The original Phase 8 text below is kept as written.

## 2. Findings ranked by severity

Each finding is marked **confirmed** (verified in code or by test) or **theoretical** (it
depends on preconditions not shown to occur).

### F-01 — No way to sign out other devices or change the password (High, confirmed)

- **Component:** `apps/api/src/modules/auth` (sessions), web and mobile settings.
- **Evidence:** before this phase, the only revocation paths were sign-out of the current
  session, refresh-token reuse and account disable. There was no endpoint to list or revoke
  other sessions and no password-change endpoint. The mobile _Security_ screen said "not
  available yet".
- **Impact:** a lost or stolen phone kept a valid session for up to 30 days, with:
  - API access;
  - its MLS device key, so it could read new messages;
  - its push token.

  After a suspected password compromise, the owner could not rotate the password or evict
  the attacker.

- **Remediation:**
  - `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others`;
  - `POST /auth/password`, which requires the current password, applies the policy and
    context checks, ends all other sessions, shares the lockout counter, is rate-limited
    (5/15 min) and is audited (`PASSWORD_CHANGED`, `PASSWORD_CHANGE_FAILED`);
  - another account's session gets the same 404 as an unknown ID;
  - revocation removes the device's MLS key and push token and closes its sockets through the
    existing `session.revoked` listeners;
  - a web _Devices & security_ page and the mobile _Security and devices_ screen.
- **Tests:**
  - `apps/api/test/session-management.test.ts` (9);
  - `apps/web/src/app/security.test.tsx` (4);
  - `apps/mobile/src/security.test.tsx` (3).

### F-02 — Production headers blocked video and voice calls (Medium, confirmed)

- **Component:** `infrastructure/docker/nginx/security-headers.conf`.
- **Evidence:** the header was `Permissions-Policy: camera=(), microphone=()`, which disables
  `getUserMedia` for the page itself. The Vite dev server does not send it, so development and
  tests could not notice.
- **Impact:** calls failed in the production web container. This was an availability defect,
  not a confidentiality one.
- **Remediation:** the header is now `camera=(self), microphone=(self)`. Geolocation, payment,
  USB and display capture stay disabled.
- **Tests:** `apps/web/src/security-headers.test.ts` (3). It reads the real nginx file and also
  asserts the strict CSP (no `unsafe-inline` or `unsafe-eval`).

### F-03 — No key-change warnings (Medium, confirmed gap)

- **Component:**
  - `packages/messaging` (engine);
  - web `ConversationPanel` and `SafetyNumberDialog`;
  - mobile `ConversationScreen` and `SafetyNumberScreen`.
- **Evidence:** safety numbers could be compared, but nothing was remembered, and nothing
  warned when a contact's device keys changed. Detecting a key substituted by a malicious
  server depended on people re-comparing numbers unprompted. The documentation listed this as
  "Planned".
- **Impact:** a server-side key substitution would go unnoticed in practice (this is
  **theoretical**: it needs a compromised or malicious server).
- **Remediation:**
  - **Detection (trust on first use):** each device stores, per contact, the device signature
    keys it last accepted (`key-tracking.ts`, sealed local store). A key never seen before
    marks the conversation _changed_ and clears any _verified_ mark. Removed keys are accepted
    silently.
  - **UI:** clients show a warning banner with _Verify_ and _Dismiss_, and a _Numbers match —
    mark as verified_ action. The header shows "Verified".
  - **Cryptography:** none was added; the check compares the same public keys the safety
    number is derived from.
- **Limitations:**
  - only direct conversations are covered;
  - the first sight is trusted;
  - the warning cannot tell a new device from an attack.
- **Tests:**
  - `packages/messaging/src/key-tracking.test.ts` (3);
  - `apps/api/test/key-change.test.ts` (2; real engine and API, including persistence across
    restart);
  - web and mobile UI tests (3 web, 2 mobile).

### F-04 — No account recovery (Medium, confirmed missing feature)

- **Component:** authentication.
- **Evidence:** there is no password-reset or account-recovery flow, and no email change.
- **Impact:** availability. A person who forgets their password loses the account. Their
  end-to-end encrypted history stays on their existing devices, but any device that signs
  out loses it. Support has no safe recovery procedure, which invites unsafe ad-hoc ones.
- **Remediation (not done):** design reset-by-email with these properties:
  - single-use hashed tokens delivered in the URL fragment;
  - a short expiry;
  - every session revoked on reset;
  - a notification to the old address;
  - an explicit statement that encrypted history is not recoverable through a reset.

  This needs a product decision and an email provider, so it was not implemented in this
  phase.

### F-05 — Push-token takeover by token holders (Low, theoretical)

- **Component:** `NotificationsService.register`.
- **Evidence:** registering a token that another device holds moves the token to the new
  device. This is deliberate, so that reinstalls and account switches work.
- **Impact:** an attacker who already knows another installation's Expo push token can:
  - stop that phone's OGC alerts;
  - make the phone receive the attacker's own generic alerts.

  No message content is exposed (payloads are generic by default), and a token is never served
  to two accounts at once. Push tokens are not displayed or logged.

- **Decision:** accepted.
- **Tests (new):** `push-notifications.test.ts`:
  - a token is bound to the registering device;
  - a body naming another device or account is rejected;
  - unregistering only affects the caller's own token;
  - after a move, alerts for the old owner never reach the token.

### F-06 — Suspension does not close open sockets immediately (Low, confirmed)

- **Component:** `SessionService.authenticate`, realtime gateway.
- **Evidence:** account status is checked on every HTTP request, and a suspended account's
  session is then revoked, which closes its sockets. A socket that makes no HTTP request keeps
  receiving realtime events until its access token expires (at most 15 minutes).
- **Impact:** limited. No code path in the application suspends accounts today; that requires
  staff action in the database.
- **Remediation (when moderation tooling lands, Phase 9):** suspension should revoke the
  sessions directly, which publishes `session.revoked` and disconnects the sockets.

### F-07 — Retention and backup gaps (Low, confirmed)

- **Evidence:**
  - delivered pushes and call history (365 days) have retention;
  - expired or revoked sessions and `audit_events` (append-only) are never purged;
  - no backup or restore procedure is documented.
- **Impact:**
  - unbounded growth of rows that hold IP addresses and user agents (privacy and data
    minimisation);
  - an untested recovery path.
- **Remediation (not done):**
  - define retention periods (for example, revoked sessions 90 days and audit 1–2 years,
    subject to legal advice);
  - add a purge job, plus an audit-retention job that works with the append-only trigger;
  - document encrypted PostgreSQL backups, restore drills and key custody.

### F-08 — Dependency advisories (Low, confirmed, accepted)

`pnpm audit:deps` passes. Four advisories remain:

- **Ignored highs**, with justification in `pnpm-workspace.yaml`:
  - `braces` (Metro and Jest);
  - `node-forge` (Expo CLI development certificates).
- **Moderates:**
  - `uuid` < 11.1.1, through `xcode` → `@expo/config-plugins`;
  - `sprintf-js` ≤ 1.1.3, through the Jest toolchain.

All four are on developer or build paths only, not in the API, web bundle or app runtime.
Re-check them on every dependency update.

### F-09 — Out-of-date security documentation (Info, fixed)

- `authentication.md` said the throttler store was in-memory, but a Redis store has been used
  since Phase 3.
- `messaging-security.md` listed key-change warnings as planned.

Both are updated.

### Reviewed areas without new findings

| Area                         | What was checked (implementation, not documentation)                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and sessions  | Global deny-by-default guard; SHA-256 hashed opaque tokens; 15 min / 30 day lifetimes; refresh CAS and reuse revocation; Argon2id + lockout; CSRF (`SameSite=Strict` + `X-OGC-Client` on cookie-authenticated changes); `__Host-` cookies                      |
| Authorization (object level) | Participant-scoped conversation, message, attachment, call and group queries; identical 404s; withheld/hidden/deleted messages and `visible_from_version` enforced on attachment download; role matrix for groups/channels; staff roles from the database only |
| MLS, devices, membership     | Key packages verified against the uploading device; foreign devices rejected from group state; one commit per epoch; logged-out or revoked devices removed from groups; safety numbers                                                                         |
| Calls                        | Signaling relayed only between the two devices in the call; stale/forged/third-party signals refused; blocks end calls silently; TURN credentials short-lived from a server-side secret; relay-only option to hide IP addresses                                |
| Push                         | Generic content by default; no message text in payloads; blocks and suspension respected; dead tokens removed                                                                                                                                                  |
| Uploads                      | Avatars: 5 MB, 40 MP limit, re-encoded with sharp, metadata stripped, client filename ignored; attachments: ciphertext only, `application/octet-stream` + `nosniff`, size limits; channel images re-encoded, other files served as downloads                   |
| Rate limits                  | Per-IP auth limits; per-account messaging, calls, push, sessions and password limits; shared via Redis                                                                                                                                                         |
| PostgreSQL, Redis, Docker    | Compose binds 127.0.0.1 only; Redis requires a password; API runs as `node`, web as unprivileged nginx; production env validation refuses HTTP origins, insecure cookies, missing Redis, development outboxes and local disk storage                           |
| Logging and monitoring       | Request bodies and query strings never logged; auth headers and cookies redacted; ciphertext and key material redacted; metrics use enum labels only; audit metadata is IDs only                                                                               |

## 3. Remediation completed

| Change                                       | Files                                                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session list and revocation, password change | `apps/api/src/modules/auth/{session.service,auth.service,auth.controller,auth.constants}.ts`, `packages/types/src/{auth,api}.ts`, `packages/validation/src/auth.ts`, `apps/api/prisma/schema.prisma`, migration `20261015132856_session_management` (additive) |
| Clients                                      | `apps/web/src/lib/api.ts`, `apps/web/src/pages/SecurityPage.tsx`, route and navigation; `apps/mobile/src/api/client.ts`, `apps/mobile/src/screens/social/SecurityScreen.tsx`; error text for `INVALID_PASSWORD`                                                |
| Camera and microphone policy                 | `infrastructure/docker/nginx/security-headers.conf`                                                                                                                                                                                                            |
| Key-change warnings                          | `packages/messaging/src/{key-tracking,client,index}.ts`; web `ConversationPanel.tsx`, `Dialogs.tsx`; mobile `ConversationScreen.tsx`, `OtherScreens.tsx`; messaging context types and test fakes                                                               |
| Documentation                                | this report; `authentication.md`, `messaging-security.md`, `data-model.md`, ADR-039, roadmap                                                                                                                                                                   |

The migration only adds enum values. It was applied to the local development database with
`prisma migrate deploy`, and no data was changed.

## 4. Tests performed and results

All results come from runs on 2026-10-15 against the local Docker PostgreSQL 18 and Redis.

**New regression tests:**

| Area (required category)                     | Tests                                                                                                                                                                                        | Result     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Auth and session abuse; cross-account access | `session-management.test.ts`: list own sessions only, no secrets; foreign session = unknown (404); CSRF; lockout sharing; rate limit (429); revoked device loses API, refresh, MLS key, push | 9 / 9 pass |
| Key changes and device changes               | `key-tracking.test.ts` (3), `key-change.test.ts` (2), web messaging UI (3), mobile messaging UI (2)                                                                                          | pass       |
| Push-token ownership                         | `push-notifications.test.ts` › push-token ownership (2)                                                                                                                                      | pass       |
| Production headers                           | `security-headers.test.ts` (3)                                                                                                                                                               | pass       |
| Session and password UI                      | web `security.test.tsx` (4), mobile `security.test.tsx` (3)                                                                                                                                  | pass       |

**Existing suites covering the other required categories** (re-run as part of `pnpm check`):

| Category                                  | Existing tests                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized group and channel operations | `groups.test.ts` (identical 404s, role matrix, invite rules), `channels.test.ts` (post policy, moderation hierarchy, bans stop realtime)                      |
| Blocked-user communication                | `messaging.e2e.test.ts` ("withholds messages…"), `calls.test.ts` (never rings, ends on block), `blocks-reports.test.ts`, `push-notifications.test.ts`         |
| Forged and stale call signaling           | `calls.test.ts` (relay only between call devices; strangers cannot inject; stale signaling refused; duplicate acceptance refused)                             |
| Encrypted-content leakage                 | `messaging.e2e.test.ts` (ciphertext only), `messaging-operations.test.ts` (log scan), `push-notifications.test.ts` (no content in pushes)                     |
| Malicious uploads                         | `profiles.test.ts` (executable, SVG, polyglot, path traversal, size), `channels.test.ts`, `messaging.e2e.test.ts` (oversized/malformed), web "disguised file" |
| Rate limits                               | `auth.security.test.ts`, `messaging-operations.test.ts`, `calls.test.ts`, `push-notifications.test.ts`, `redis-scaleout.test.ts`                              |

**Full gate** (`pnpm check`: format, lint, typecheck, build, all tests) passed on 2026-10-15:
API 414 tests in 44 files (real PostgreSQL and Redis), web 106, mobile 72, validation 102,
messaging 43, e2ee 27, ui 14 — all passing. `pnpm audit:deps` passed (see F-08);
`prisma validate` passed. No assertions were weakened and no timeouts were raised.

**Not performed:**

- penetration testing;
- fuzzing;
- an independent cryptographic review;
- load or denial-of-service testing;
- testing on physical iOS or Android devices;
- tests against a real push provider or TURN server.

## 5. Remaining risks and accepted limitations

**Cryptography and calls:**

- **`ts-mls` is not audited**, and neither is OGC's MLS integration. This must be reviewed
  before production.
- **Calls are not end-to-end authenticated like messages.** Media uses DTLS-SRTP, but the DTLS
  fingerprints travel through the OGC server and are not bound to MLS identities. A malicious
  server could therefore intercept call media. Calls must not be described as end-to-end
  encrypted.
- **IP addresses:** peer-to-peer calls reveal them to the other participant unless relay-only
  is configured (`WEBRTC_ICE_TRANSPORT_POLICY=relay` with TURN).

**Key-change detection:**

- it trusts the first keys a device sees;
- it covers direct conversations only;
- verification state is lost with the device.

**Accounts and operations:** F-04, F-06 and F-07 were addressed in Phase 9. Email is now the
recovery factor (no second factor yet), and backups still need scheduling and an offline key.

**Server visibility:**

- **Metadata** is visible to the server: who talks to whom and when, sizes, group membership,
  presence, and call times and durations.
- **Community channels** are server-readable by design and labelled as such.

**Client-side limits:**

- **Web XSS:** a script running in the page could use the device's non-extractable sealing key
  while the page is open. The strict CSP and text-only rendering mitigate this.
- **Object storage** is not implemented, and production refuses local disk. Avatars and
  attachments therefore stay disabled in production until an S3-compatible driver exists.
- **Mobile:** the Hermes crypto shim, `react-native-webrtc` and push delivery are untested on
  physical devices.

## 6. Production deployment security checklist

- [ ] `NODE_ENV=production`; the API refuses to start if any production check fails.
- [ ] HTTPS everywhere: `WEB_APP_URL` and `CORS_ORIGINS` use `https://`; HSTS at the edge;
      `COOKIE_SECURE=true`.
- [ ] `TRUST_PROXY_HOPS` matches the real proxy chain, so client IPs used for rate limits
      cannot be spoofed.
- [ ] PostgreSQL:
  - a least-privilege application role (no superuser);
  - `sslmode=require`;
  - not reachable from the internet;
  - encrypted backups with a tested restore.
- [ ] Redis:
  - a strong password;
  - TLS or a private network;
  - not reachable from the internet;
  - `REDIS_URL` set (required).
- [ ] Secrets come from a secret manager, never from the repository, images or client bundles:
  - the database password;
  - the Redis password;
  - `WEBRTC_TURN_SECRET`;
  - the Expo access token;
  - the email provider credentials.

  Rotate them on staff changes.

- [ ] Real email transport configured (the outbox is refused); SPF, DKIM and DMARC set for the
      sending domain.
- [ ] `PUSH_PROVIDER=expo` with an access token; the development outbox is refused.
- [ ] TURN server with the REST shared secret. Use `WEBRTC_ICE_TRANSPORT_POLICY=relay` if hiding
      IP addresses matters more than latency.
- [ ] Web served by the provided nginx image. Check that the CSP and `Permissions-Policy`
      headers arrive unchanged through any CDN.
- [ ] Containers:
  - run as non-root (as built);
  - read-only root filesystem where possible;
  - images rebuilt on base-image security updates.
- [ ] `pnpm audit:deps` is clean at release; review the ignored advisories.
- [ ] Logs:
  - the level is `info` or quieter;
  - log shipping keeps the redaction;
  - retention is defined;
  - access is restricted.
- [ ] Monitoring and alerting:
  - auth failures and lockouts;
  - `REFRESH_TOKEN_REUSE_DETECTED`;
  - 429 rates;
  - push failure rates;
  - API error rates.
- [ ] Retention periods confirmed by legal review (defaults in data-retention.md; job implemented).
- [ ] SMTP provider configured (`EMAIL_TRANSPORT=smtp`, SPF/DKIM/DMARC) so recovery works.
- [ ] Encrypted backups scheduled off-site, offline private key held by named custodians,
      restore drill done.
- [ ] Independent review completed (section 7).

## 7. Recommendations for an independent professional review

Before handling real users' data, commission the following from qualified external parties:

1. **Cryptographic review:**
   - `ts-mls` and OGC's MLS integration (`packages/messaging`), covering:
     - key-package validation;
     - external commits and Welcomes;
     - device removal;
     - group membership changes;
     - AAD binding;
     - local key storage on web (WebCrypto) and mobile (Keychain/Keystore and the Hermes shim);
   - the safety-number and key-change design.
2. **Penetration test** of the API, realtime gateway and web app:
   - authentication and session handling;
   - object-level authorization;
   - WebSocket abuse;
   - upload handling;
   - rate-limit bypass through proxies.
3. **Call security review:**
   - signaling integrity;
   - TURN configuration;
   - IP exposure;
   - whether to bind DTLS fingerprints to MLS identities before calls are described as end to
     end encrypted.
4. **Mobile assessment on physical iOS and Android devices:**
   - secure storage;
   - backup exclusion;
   - screenshots in the app switcher;
   - push behaviour;
   - crypto performance and correctness under Hermes.
5. **Infrastructure review** of the production deployment against the checklist in section 6.
