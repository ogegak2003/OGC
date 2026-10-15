# Authentication security

Security design and controls for Phase 1 identity and authentication. Architecture:
[identity-and-authentication.md](../architecture/identity-and-authentication.md).

Phase 8 review: [security-review.md](security-review.md).

## Passwords

| Aspect        | Decision                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Hashing       | Argon2id, m = 19 MiB, t = 2, p = 1 (OWASP minimum), random salt, PHC string (ADR-014)                     |
| Upgrades      | Hashes with outdated parameters are re-hashed at the next successful sign-in                              |
| Policy        | 12–128 characters, **no composition rules** (NIST SP 800-63B); spaces and any Unicode allowed             |
| Blocked       | Common passwords, fewer than 5 distinct characters, passwords based on the email or brand                 |
| Normalisation | Unicode NFKC before hashing, so the same password works on every device and keyboard                      |
| Never         | stored or logged in plaintext, returned by any API, placed in tokens, or sent to the frontend after entry |

Planned: breached-password screening (k-anonymity range queries, e.g. Have I Been Pwned)
once an outbound-request policy is agreed.

## Sessions and tokens

| Threat                     | Control                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database leak              | Tokens stored only as SHA-256 hashes; passwords as Argon2id                                                                                                                                             |
| Stolen access token        | 15-minute lifetime; server-side check on every request; revocable                                                                                                                                       |
| Stolen refresh token       | Rotation on every use; replaying a superseded token revokes the session (`REFRESH_TOKEN_REUSE_DETECTED`)                                                                                                |
| Concurrent refresh races   | Compare-and-swap update; clients serialise refreshes (single-flight)                                                                                                                                    |
| Session fixation           | Tokens are always generated server-side at sign-in; nothing client-supplied is adopted                                                                                                                  |
| Indefinite sessions        | 30-day absolute lifetime                                                                                                                                                                                |
| Suspended account still in | Account status checked on every request; sessions revoked (`ACCOUNT_DISABLED`)                                                                                                                          |
| Token theft via XSS (web)  | Tokens only in `HttpOnly` cookies — unreadable by JavaScript; strict CSP on the web app                                                                                                                 |
| CSRF (web)                 | `SameSite=Strict` cookies **and** a required `X-OGC-Client: web` header on cookie-authenticated state changes (cross-site requests cannot add it without a CORS preflight, which the allowlist rejects) |
| Cookie injection/overwrite | `__Host-` / `__Secure-` cookie prefixes and `Secure` in production (enforced by env validation)                                                                                                         |
| Refresh cookie exposure    | Refresh cookie scoped to `Path=/api/v1/auth`                                                                                                                                                            |
| Token theft on mobile      | Refresh token in Keychain/Keystore via `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (not backed up or migrated); access token in memory; **no AsyncStorage**                                   |
| Tokens in logs             | Auth headers and cookies redacted; request bodies and query strings never logged; verified by a test that scans trace-level log output                                                                  |

## Devices, sign-out and password change (Phase 8)

| Endpoint                            | Behaviour                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /auth/sessions`                | The account's active sessions (platform, device name, created / last active / expiry, `current`). No tokens, hashes or IP addresses                          |
| `DELETE /auth/sessions/:id`         | Signs out one own session (e.g. a lost phone). Someone else's session gets the same `404` as an unknown ID; reason `USER_REVOKED` (`LOGOUT` for the current) |
| `POST /auth/sessions/revoke-others` | Ends every other session of the account; the current one stays                                                                                               |
| `POST /auth/password`               | Requires the current password; new password must meet the policy and differ; on success every other session ends (`PASSWORD_CHANGED`)                        |

Revocation is immediate: the session's next API request is `401`, its refresh token is
dead, its sockets are disconnected, and its device's MLS key and push token are removed
(`session.revoked` listeners), so a signed-out device cannot read new messages or receive
notifications. A wrong current password on `/auth/password` counts toward the same lockout
counter as sign-in (`PASSWORD_CHANGE_FAILED` audited) and the endpoint is rate-limited
(5 per 15 minutes); cookie-authenticated calls need the CSRF header like every other change.
Web: _Devices & security_ page; mobile: _Security and devices_ screen. Tests:
`apps/api/test/session-management.test.ts`.

## Password recovery and suspension (Phase 9)

- **Password reset by email:** `POST /auth/password/forgot` always gets the same answer, and
  `POST /auth/password/reset` takes a single-use hashed token and ends every session. Details,
  and what recovery does not restore: [account-recovery.md](account-recovery.md).
- **Change and reset notices:** a confirmation email is sent after every password change and
  reset.
- **Suspension:** `POST /admin/accounts/:ogcId/suspend` and `/reinstate` are `ADMIN` only and
  audited with actor and reason. Suspension revokes every session at once. Open sockets also
  re-check their session and account status every `REALTIME_SESSION_CHECK_MS` (30 s), so a
  status changed directly in the database takes effect too.

## Account enumeration

| Surface             | Control                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Registration        | Identical `202` response and work (Argon2 hash) for new and existing emails; owner notified by email                                     |
| Login               | One generic `INVALID_CREDENTIALS` for unknown account, wrong password, and locked credential; dummy Argon2 verification equalises timing |
| Account status      | `ACCOUNT_UNAVAILABLE` only after a correct password                                                                                      |
| Email verification  | Same error for unknown, expired, and used tokens                                                                                         |
| Resend verification | Requires a session; same response whether or not an email was sent                                                                       |

Residual: registration of an existing email skips the database insert, a small timing
difference relative to the Argon2 cost; rate limits bound how fast it could be probed.

## Brute force and abuse

| Control             | Setting                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Per-IP rate limits  | register 10/h · login 10/min · refresh 60/min · verify 20/h · resend 5/h · forgot 5/15 min · reset 10/15 min |
| Per-account lockout | 10 consecutive failures → 15-minute lock; same generic error; `ACCOUNT_LOCKED` audited                       |
| Verification emails | At most one per account per minute                                                                           |
| Client IP           | From `X-Forwarded-For` only when `TRUST_PROXY_HOPS` is configured                                            |

Rate-limit counters are shared through Redis (`RedisThrottlerStorage`) when `REDIS_URL` is
set — which production configuration requires — and in-memory per instance otherwise.

Known limitations: per-account lockout can be
triggered by an attacker who knows an email (temporary denial of service); it is short and
does not reveal anything. Progressive delays and CAPTCHA/proof-of-work on suspicious
traffic are candidates for Phase 10.

## Email verification tokens

256-bit random, SHA-256-hashed at rest, single use, 24-hour expiry; issuing a new one
invalidates the old. Delivered in the URL **fragment** (`#token=`), which never reaches
servers or `Referer` headers; the web app removes it from the address bar after use. With no
email provider configured, delivery is `disabled` (nothing sent, nothing logged); the
development `outbox` writes owner-only files and is rejected in production.

## Audit events

Recorded in the append-only `audit_events` table: `USER_REGISTERED`,
`REGISTRATION_EMAIL_IN_USE`, `LOGIN_SUCCEEDED`, `LOGIN_FAILED` (reason: `unknown_account`,
`invalid_password`, `locked`, `account_unavailable`), `ACCOUNT_LOCKED`, `SESSION_CREATED`,
`SESSION_REFRESHED`, `SESSION_REVOKED` (reason), `REFRESH_TOKEN_REUSE_DETECTED`,
`EMAIL_VERIFICATION_SENT`, `EMAIL_VERIFIED`, `EMAIL_VERIFICATION_FAILED`, `PASSWORD_CHANGED`,
`PASSWORD_CHANGE_FAILED`, `PASSWORD_RESET_REQUESTED` (outcome), `PASSWORD_RESET_COMPLETED`,
`PASSWORD_RESET_FAILED` (reason), `ACCOUNT_SUSPENDED`, `ACCOUNT_REINSTATED`, `RETENTION_PURGED`.

Each event stores type, user and session IDs, IP address, truncated user agent, and
non-sensitive metadata. Never credentials, tokens, or token hashes — verified by test.

## Verification

Automated tests (`apps/api/test/*.test.ts`) run against a real PostgreSQL database and cover
every control above: generic errors and identical responses, timing parity, lockout, rate
limits (`429` with `Retry-After`), CSRF rejection, cookie attributes, rotation and reuse
detection, expiry, revocation, suspension, the absence of secrets in responses, logs and
audit records, and database constraints.
