# Identity and authentication

Phase 1 establishes who a user is (identity), how they prove it (authentication), and how
a proven identity is carried through every later request (sessions and the auth context).
Security rationale and controls are in
[docs/security/authentication.md](../security/authentication.md); database details in
[data-model.md](data-model.md).

## Identity model

Five concerns, deliberately kept apart:

| Concern              | Where                    | Notes                                                             |
| -------------------- | ------------------------ | ----------------------------------------------------------------- |
| Internal user ID     | `users.id` (UUIDv7)      | Never exposed by any API. Used for all foreign keys.              |
| Public OGC ID        | `users.ogc_id`           | Random, unique, immutable (DB trigger), safe to share. See below. |
| Account state        | `users.status`, `email…` | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED`.     |
| Credentials          | `credentials`            | One row per method (`PASSWORD` today; passkeys/OAuth later).      |
| Profile              | `profiles`               | Display name now; avatar, bio, visibility later (Phase 2).        |
| Devices and sessions | `devices`, `sessions`    | Each sign-in = one device + one session, independently revocable. |

No phone number is required or stored. Phone-number linking, if ever added, becomes a new
credential/contact method — it does not change the identity model.

## OGC ID generation

Format: `OGC` + 9 digits, first digit non-zero — e.g. `OGC482731905`, displayed as
`OGC 482 731 905` ([ADR-008](decisions.md#adr-008-random-9-digit-ogc-ids)).

1. `OgcIdGenerator` draws a number uniformly from `[100 000 000, 999 999 999]` using
   `crypto.randomInt` (CSPRNG, rejection-sampled, unbiased). No counters, timestamps,
   row numbers, email, or phone data are involved.
2. `IdentityService.withNewOgcId()` runs the registration transaction with that ID.
3. The **database unique index** is the source of truth for uniqueness. On a unique
   violation of `ogc_id`, the whole transaction rolls back and is retried with a fresh
   random ID (up to 5 attempts — with 900M IDs, repeated collisions indicate a fault).
4. A `CHECK` constraint enforces the format and a trigger makes the column immutable.

The random source is injectable, so tests prove collision handling deterministically
against the real database (`test/auth.register.test.ts`).

## Authentication model

**Server-side sessions with opaque tokens** ([ADR-009](decisions.md#adr-009-opaque-server-side-sessions-with-rotating-refresh-tokens)) — not self-contained JWTs.

| Token         | Format                                | Lifetime                             | Stored server-side as |
| ------------- | ------------------------------------- | ------------------------------------ | --------------------- |
| Access token  | `ogc_at_<256-bit secret>`             | 15 minutes                           | SHA-256 hash          |
| Refresh token | `ogc_rt_<sessionId>_<256-bit secret>` | Session lifetime (30 days, absolute) | SHA-256 hash          |

- Every authenticated request looks the access token up by hash, so **revocation and
  suspension take effect immediately**. (A cache can be added later without changing
  clients.)
- Refresh tokens **rotate on every use**. The session ID inside the token lets the server
  recognise an old, already-rotated token: presenting one is treated as theft and
  **revokes the whole session**. A compare-and-swap update makes concurrent refreshes safe.
- Sessions have an absolute lifetime; after 30 days the user signs in again.

### Clients

| Client | How tokens travel                                                           | Storage                                                                                            |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Web    | `HttpOnly`, `SameSite=Strict` cookies (`__Host-`/`__Secure-` in production) | Browser cookie jar; **JavaScript never sees a token**                                              |
| Mobile | `Authorization: Bearer` + refresh token in the request body                 | Refresh token in `expo-secure-store` (Keychain/Keystore, this-device-only); access token in memory |

A browser identifies itself with the header `X-OGC-Client: web`, which selects cookie
mode and doubles as the CSRF defence ([ADR-010](decisions.md#adr-010-browser-sessions-use-httponly-cookies-native-apps-use-bearer-tokens)).

## Account states and verification

| State                  | Can sign in? | Can use features?                                    |
| ---------------------- | ------------ | ---------------------------------------------------- |
| `PENDING_VERIFICATION` | Yes          | Only `/auth/me`, `/auth/logout`, verification resend |
| `ACTIVE`               | Yes          | Yes                                                  |
| `SUSPENDED`            | No           | No — existing sessions are revoked on next request   |
| `DEACTIVATED`          | No           | No — existing sessions are revoked on next request   |

Verification: registration emails a single-use link `…/verify-email#token=<secret>` (24 h).
The token sits in the URL **fragment**, which browsers never send to servers or in
`Referer` headers. Verifying activates a pending account but never lifts a suspension.

Email delivery is behind an `EmailSender` port: `disabled` (default) or a development-only
file `outbox`. No provider is configured yet ([ADR-011](decisions.md#adr-011-registration-never-reveals-whether-an-email-is-registered)).

## Flows

### Registration

1. Validate and normalise input (`registerRequestSchema`: email NFKC + lower-case, password
   policy, display name).
2. Hash the password with Argon2id — on **every** path, so timing does not reveal whether
   the email exists.
3. If the email is already registered: record `REGISTRATION_EMAIL_IN_USE`, email the owner
   an "account exists" notice, and return the **same 202 response** as success.
4. Otherwise, in **one transaction** with a fresh random OGC ID: create the user, profile,
   password credential, and hashed verification token; record `USER_REGISTERED`.
5. Send the verification email; record `EMAIL_VERIFICATION_SENT`.
6. Return `202 { verificationRequired: true, message }`. **No session is created.**

### Sign-in

1. Look up the account by normalised email.
2. Unknown account → verify against a dummy Argon2 hash (equal timing) → generic `401`.
3. Credential locked (10 consecutive failures → 15 min) → generic `401`.
4. Wrong password → increment failure counter, maybe lock → generic `401`.
5. Correct password but `SUSPENDED`/`DEACTIVATED` → `403 ACCOUNT_UNAVAILABLE` (revealed only
   to someone who knows the password).
6. Success → reset counters, upgrade the hash if parameters changed, create device +
   session in one transaction, record `LOGIN_SUCCEEDED` + `SESSION_CREATED`.

## API endpoints

All under `/api/v1/auth`. Request bodies are validated with the shared Zod schemas in
`@ogc/validation`; unknown fields are rejected. Errors use `ApiErrorBody` with a `code`.

| Method & path               | Auth                 | Rate limit (per IP) | Success                  | Notes                                                                    |
| --------------------------- | -------------------- | ------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `POST /register`            | Public               | 10 / hour           | `202 RegisterResponse`   | Identical response for new and existing emails                           |
| `POST /login`               | Public               | 10 / minute         | `200 AuthResponse`       | Native clients must send `device: { platform }`                          |
| `POST /refresh`             | Refresh token        | 60 / minute         | `200 AuthResponse`       | Rotates tokens; reuse revokes the session                                |
| `POST /logout`              | Session              | global              | `204`                    | Revokes the current session, clears cookies                              |
| `GET /me`                   | Session (pending OK) | global              | `200 AccountView`        | `{ ogcId, displayName, email, emailVerified, accountStatus, createdAt }` |
| `POST /verify-email`        | Public (token)       | 20 / hour           | `200 { verified: true }` | Generic error for unknown/expired/used tokens                            |
| `POST /verify-email/resend` | Session (pending OK) | 5 / hour            | `202 { message }`        | Silently limited to one email per minute                                 |

`AuthResponse` = `{ account: AccountView, session: { accessTokenExpiresAt, expiresAt },
tokens? }` — `tokens` is present **only** for native clients. The internal user ID is never
returned.

Error codes: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`,
`ACCOUNT_UNAVAILABLE`, `EMAIL_NOT_VERIFIED`, `INVALID_VERIFICATION_TOKEN`,
`CSRF_REJECTED`, `RATE_LIMITED`.

## Using authentication in new endpoints

The global `AuthGuard` is **deny-by-default**:

```ts
@Controller('contacts')
export class ContactsController {
  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    // auth.userId comes from the verified session — never from the request body or URL.
    return this.contacts.listFor(auth.userId);
  }
}
```

- No decorator → requires a valid session for an `ACTIVE` account.
- `@AllowPendingVerification()` → also admits unverified accounts.
- `@Public()` → no authentication (use sparingly; add a `@Throttle` limit).
- `AuthContext` = `{ userId, ogcId, accountStatus, sessionId, deviceId, via }`. Role-based
  authorization (Phase 9 admin, group roles in Phase 5) will extend this context and add
  policy guards; endpoints keep taking identity only from it.

## Device architecture

Each sign-in creates a `Device` (platform, optional label) and a `Session` bound to it.
Today a device has exactly one session; the model already supports:

- **Logout from all devices** — revoke every session of a user (one `UPDATE`).
- **Device management** — list devices with `last_seen_at`, revoke individually.
- **Device re-use** — a native app can later register a persistent installation identity
  so re-sign-ins attach to the same device.
- **End-to-end encryption** — devices become the holders of per-device public keys
  ([ADR-012](decisions.md#adr-012-messaging-is-designed-for-end-to-end-encryption)).

## QR identity

The QR code encodes only the public identity link `ogc://id/<OGC ID>` (`buildOgcIdLink` in
`@ogc/validation`) — never tokens, credentials, keys, or private data. A future scan resolves
the ID server-side into a profile/contact flow (Phase 2). The link base becomes an https
universal link once a public domain is approved ([ADR-013](decisions.md#adr-013-qr-codes-encode-only-a-public-identity-link)).
