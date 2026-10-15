# Account recovery

Phase 9. Decision: [ADR-040](../architecture/decisions.md#adr-040-password-recovery-retention-suspension-and-backups).
Code: `apps/api/src/modules/auth/auth.service.ts` (`forgotPassword`, `resetPassword`),
`apps/api/src/modules/email/`. Tests: `apps/api/test/password-reset.test.ts`,
`apps/api/src/modules/email/senders.test.ts`, web `src/app/password-reset.test.tsx`, mobile
`src/password-reset.test.tsx`.

## What "recovery" means in OGC

OGC can give a person back their **account**: OGC ID, profile, contacts, groups and channel
memberships, settings. It **cannot** give back end-to-end encrypted **message history**. The
server never holds the keys that decrypt messages. They are created on each device and stay there
(the Keychain or Keystore on mobile, a non-extractable WebCrypto key on web). A password reset is
therefore a change of the password, not a recovery of keys.

| After a password reset                   | What happens                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account, OGC ID, profile, contacts       | Unchanged                                                                                                                                                                                                     |
| Group and channel memberships            | Unchanged                                                                                                                                                                                                     |
| Every session                            | Ended (`PASSWORD_RESET`): API access, refresh and open realtime connections stop at once                                                                                                                      |
| Each device's MLS key and push token     | Removed, exactly as on any sign-out (`session.revoked`). The reset code itself does not touch encryption keys                                                                                                 |
| Messages already on a device             | The app erases its local messaging data when it sees it was signed out while running; a device that was closed may keep its sealed local copy until the app next runs. In either case it receives nothing new |
| Signing in again on a device             | The device registers a **new** MLS key and joins conversations again. It reads only messages sent **after** it joined                                                                                         |
| Messages sent while no device was active | Not readable by any device of the person; senders see their own copies                                                                                                                                        |

Nothing is reset, regenerated or destroyed silently. Keys go only through the existing sign-out
path, which the person triggers by resetting. The reset page and the email both say plainly that a
reset cannot restore encrypted messages.

## Flow

1. **Request.** The person enters their email (web `/forgot-password`, or the mobile sign-in
   screen → _Forgot your password?_). Then `POST /api/v1/auth/password/forgot` runs:
   - The answer is **always** the same `202`, with the same text, whether the address has an
     account, has none, belongs to a suspended account, or is throttled.
   - The email is sent **in the background**, so the provider's latency cannot reveal whether
     an account exists.
   - Addresses without an account get **no** email, so OGC cannot be used to send mail to
     arbitrary addresses.
   - The reason is recorded only in the audit log: `PASSWORD_RESET_REQUESTED` with outcome
     `sent`, `unknown_account`, `account_unavailable` or `throttled`.
2. **Email.** The email contains `https://<WEB_APP_URL>/reset-password#token=ogc_pr_<secret>`:
   - The token is in the URL **fragment**, which browsers never send to servers or in
     `Referer` headers.
   - The web page removes it from the address bar on load.
   - The email states the expiry and what a reset does to encrypted messages.
3. **Reset.**
   - **Web:** the page reads the token from the fragment.
   - **Mobile:** the person pastes the link or the token; universal links are not configured
     yet.
   - Both then call `POST /api/v1/auth/password/reset` with `{ token, newPassword }`.
   - On success, every session ends and a "your password was changed" email is sent.
4. **Sign in** again everywhere with the new password.

## Token rules

| Property      | Implementation                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Secret        | 256 bits from the OS CSPRNG, base64url, prefixed `ogc_pr_` (recognisable to secret scanners)                                        |
| Storage       | SHA-256 hash only (`password_reset_tokens.token_hash`, unique); the token is never stored, logged or audited                        |
| Lifetime      | `PASSWORD_RESET_TTL_MINUTES`, default 30 (5–120)                                                                                    |
| Single use    | Consumed with a compare-and-swap (`consumed_at IS NULL AND expires_at > now`): of two simultaneous uses, exactly one succeeds       |
| Superseding   | A new link retires every earlier one, and a successful reset retires all outstanding links                                          |
| Wrong account | A link stops working if the account is suspended or deactivated after it was sent                                                   |
| Errors        | Unknown, used, expired and superseded links get the same `400 INVALID_RESET_TOKEN`; the reason is audited (`PASSWORD_RESET_FAILED`) |
| Weak password | Same policy as registration (length, common and context words). The link **stays valid** so the person can choose another password  |
| Lockout       | A successful reset clears the sign-in lockout (control of the mailbox is proven)                                                    |

## Abuse limits

| Limit                        | Value                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| Requests per client IP       | 5 per 15 minutes (`429`)                                                |
| Reset attempts per client IP | 10 per 15 minutes (`429`); each guess is a 256-bit search               |
| Emails per account           | at most 1 per minute and 3 per hour; extra requests get the same answer |

Rate-limit counters are shared through Redis in production.

## Email provider

`EMAIL_TRANSPORT` selects the provider:

| Value      | Behaviour                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `disabled` | Default. Nothing is sent. `forgot-password` answers `503 EMAIL_UNAVAILABLE` for **every** address: honest, and it reveals nothing about accounts |
| `outbox`   | Development only (refused in production): each email is written to an owner-only file in `EMAIL_OUTBOX_DIR`                                      |
| `smtp`     | Any SMTP provider (Amazon SES, Postmark, SendGrid, Mailgun, a company relay)                                                                     |

For `smtp`, set:

- `EMAIL_FROM` and `SMTP_HOST`;
- `SMTP_PORT` (default 587) and `SMTP_SECURITY`:
  - `starttls`: the upgrade is required and never falls back to plaintext;
  - `tls`: implicit TLS, usually port 465;
  - `none`: local mail catchers only, refused in production;
- `SMTP_USER` and `SMTP_PASSWORD`, which must be set together;
- `SMTP_TIMEOUT_MS`.

TLS 1.2 or later with certificate verification is enforced. The implementation uses
`nodemailer` 10.1.0 (no dependencies, MIT-0), with its own logging turned off.

**Failures.** OGC logs only the email kind and the provider's error code, never the recipient,
the body or the provider's reply. If a reset email cannot be delivered:

- the requester still gets the same answer;
- the undeliverable link is retired;
- `PASSWORD_RESET_FAILED` (`email_delivery_failed`) is audited.

**Provider setup (manual).**

1. Choose a provider and verify the sending domain.
2. Publish SPF, DKIM and DMARC records for it.
3. Create SMTP credentials limited to sending.
4. Store them in the deployment's secret manager.
5. Set the variables above.
6. Send a test reset to a mailbox you control.

No provider is configured in this repository, and no real email has been sent by these tests.
The SMTP path is tested against a local in-process SMTP server.

## Known limitations

- **No key or history recovery.** This is by design: see above, and future work below.
- **Email is the recovery factor.** Whoever controls the mailbox can take over the account.
  Mitigations:
  - the confirmation email to the same address;
  - all sessions end on reset, so a hijacker also signs out the owner, who notices;
  - safety-number warnings tell contacts that keys changed.

  Optional second factors (TOTP or passkeys) would strengthen this. They are not implemented.

- **Mobile deep links.** The phone uses a paste-the-link step until universal or app links are
  configured on an approved domain.
- **Residual timing.** A real request writes one token row more than a request for an unknown
  address. Rate limits bound how fast this could be probed. The same residual is documented
  for registration.
- **No email change** flow exists yet.

## Future recovery architecture (needs its own security design)

Restoring encrypted history to a new device after losing every device requires keys that survive
the devices. Each option below changes OGC's trust model, so none may be built without a
separate design, threat model and independent review.

- **Encrypted key or history backup, with a key the server never sees.** For example, a
  high-entropy recovery code shown once. Avoid a password-derived key unless it is protected by
  a hardware-backed rate-limited service, because offline guessing breaks weak secrets.
- **Device-to-device transfer** while one old device still exists. This is the most practical
  first step: it is already planned as "encrypted history transfer to new devices".
- **Social or threshold recovery** (shares held by trusted contacts).
- **Platform backups** (iCloud Keychain or Android Backup). These delegate trust to Apple or
  Google; whether to accept that is a product decision.

None of these is implemented, and none is implied by a password reset.
