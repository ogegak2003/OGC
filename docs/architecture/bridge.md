# OGC Bridge: calls to telephone networks

Status: **Optional, off by default.** Implemented and tested locally against a simulated
provider (`BRIDGE_PROVIDER=simulated`). **No real telephone provider is integrated**: no
provider adapter, credentials, commercial agreement or regulatory approval exists yet, so no
real SMS has been sent and no real call has been placed. See
[operations/bridge-readiness.md](../operations/bridge-readiness.md) for the status matrix and
what is needed before launch.

OGC Bridge lets an OGC member call a **contact's ordinary telephone** through an authorized
voice provider. It is an isolated subsystem: OGC identity, authentication, end-to-end encrypted
messaging, contacts, groups, channels, notifications and OGC-to-OGC WebRTC calls
([calls.md](calls.md)) are unchanged, and none of them depend on Bridge.

## Principles

- **Off unless switched on.** With `BRIDGE_ENABLED=false` (the default) every Bridge endpoint
  answers `403 BRIDGE_DISABLED` (except unlinking a number already linked), webhooks are
  rejected, and the web Calls page shows no Bridge entry.
- **Truthful.** With no provider (`BRIDGE_PROVIDER=disabled`) the app says "not configured".
  The development simulator labels every code and call as simulated and never charges.
  Call states and charges come only from signed provider events.
- **Not end-to-end encrypted.** Audio travels over the public telephone network; OGC and the
  provider can process it. The app discloses this before use. OGC only controls and monitors
  the call; it never carries the audio.
- **Numbers stay private.** A number is shown only to its owner, masked
  (`+254 7•• •••678`). Other members see only whether they can call someone, never the
  number or whether a number exists (`UNAVAILABLE` covers "no number", "opted out" and
  "not callable"). Logs and audit events never contain full numbers or codes.
- **Consent.** Linking requires an explicit consent checkbox and proof of possession (SMS
  code). Receiving Bridge calls requires a separate opt-in (`allowContactCalls`, off by
  default). Only accepted contacts can call; blocks in either direction prevent calls.

## Call model: click-to-call

```
 Caller (OGC app)          OGC API                     Provider              Telephones
 ───────────────           ───────                     ────────              ──────────
 POST /bridge/calls ─────▶ authorize, check rules,
                           create call (REQUESTED) ──▶ startCall(from, to) ─▶ ring caller's
                                                                              own phone
                                                                              (answers)
                                                                           ─▶ ring callee
 GET /bridge/calls/:id ◀── state ◀── signed webhooks ◀─ RINGING/ANSWERED/…
 POST …/:id/end ─────────▶ provider.endCall ────────▶ hang up
                                          ◀═══ audio: telephone network only ═══▶
```

The provider first rings the **caller's own verified phone**, then bridges it to the callee.
This needs no audio SDK in the app, works with any phone, and keeps audio off OGC servers.
It is why the caller must link a number first (`CALLER_NUMBER_REQUIRED`).

Consequence for billing: providers usually bill **both legs** (caller and callee). The ledger
currently prices the call with one tariff by destination prefix (the callee leg); the
commercial model must be settled with the chosen provider before paid calls are enabled
(spend cap is `0` by default, so no paid call can start).

## Components (`apps/api/src/modules/bridge`)

| File                             | Role                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `provider/bridge-provider.ts`    | Provider-neutral interface: send code, start/end call, status, parse and verify webhooks. |
| `provider/disabled.provider.ts`  | No provider: every operation is refused (`BRIDGE_NOT_CONFIGURED`).                        |
| `provider/simulated.provider.ts` | Development only (refused in production). Outbox codes, signed simulated events.          |
| `provider/webhook-signature.ts`  | HMAC-SHA256 over the raw body with a timestamp; constant-time comparison.                 |
| `destination-rules.ts`           | Toll-fraud rules: country allowlist, blocked prefixes, number type (mobile/fixed only).   |
| `bridge-numbers.service.ts`      | Linking, SMS verification, preferences, unlinking, recycled-number handling.              |
| `bridge-calls.service.ts`        | Eligibility, call start (idempotent), state machine, webhook application, timeouts.       |
| `bridge-billing.service.ts`      | Tariffs, spend cap, append-only usage ledger, staff adjustments, reconciliation.          |
| `bridge-webhooks.controller.ts`  | `POST /api/v1/bridge/webhooks/:provider` (public, signature-authenticated, raw body).     |
| `bridge.controller.ts`           | Member endpoints under `/api/v1/bridge`, staff endpoints under `/api/v1/admin/bridge`.    |

A real provider is added as one more class implementing `BridgeProvider`, one more value of
`BRIDGE_PROVIDER`, and its credentials as environment variables. Nothing else changes.

Shared contracts: `@ogc/types` (`bridge.ts`) and `@ogc/validation` (`bridge.ts`, number
normalisation with `libphonenumber-js`). Web: `apps/web/src/lib/bridge-api.ts` and
`apps/web/src/pages/BridgePage.tsx` (route `/calls/bridge`). Mobile: **not implemented**.

## Endpoints

Member (signed in, verified account, rate-limited per account):

| Method and path                              | Purpose                                                        |
| -------------------------------------------- | -------------------------------------------------------------- |
| `GET /bridge`                                | Status: enabled, provider, live dialing, countries, own number |
| `POST /bridge/number/verification`           | Start (or resend) verification: `{country, number, consent}`   |
| `POST /bridge/number/verify`                 | Confirm the code: `{verificationId, code}`                     |
| `PATCH /bridge/number`                       | `{allowContactCalls}`                                          |
| `DELETE /bridge/number`                      | Unlink (allowed even when Bridge is disabled)                  |
| `GET /bridge/eligibility?ogcId=`             | `{eligible, reason}` for one contact                           |
| `POST /bridge/calls`                         | Start a call: `{ogcId, idempotencyKey}`                        |
| `GET /bridge/calls`, `GET /bridge/calls/:id` | Own calls only                                                 |
| `POST /bridge/calls/:id/end`                 | End or cancel                                                  |
| `GET /bridge/usage`                          | Own ledger entries and today's call count                      |

Staff (`ADMIN`): `POST /admin/bridge/adjustments` (audited ledger adjustment),
`GET /admin/bridge/reconciliation`.

## Verification

- Number normalised to E.164 for the selected country; must be a **mobile** number in an
  enabled country.
- 6-digit code from `crypto.randomInt`; only `HMAC(BRIDGE_CODE_SECRET, verificationId:code)`
  is stored; compared in constant time. Expires after 10 minutes; 5 attempts (counted before
  comparing); resend after 60 seconds; at most 5 codes per number and 10 verifications per
  account per day. If sending fails, the code is expired immediately.
- On success, in one transaction: the verification is consumed, the account's previous
  number is revoked, and **any other account's active link to the same number is revoked**
  (`REPLACED`, audited) — telephone numbers are recycled, so the latest proven possession wins.
  Partial unique indexes guarantee one active number per account and one active account per
  number.

## Call lifecycle and integrity

States: `REQUESTED → RINGING → ANSWERED → COMPLETED`, or a final `BUSY`, `NO_ANSWER`,
`REJECTED`, `FAILED`, `CANCELED`.

- **Forward only.** Each status has a rank; an event can only move a call forward, and final
  states never change. Updates are compare-and-set, so concurrent webhooks cannot regress
  a call.
- **Webhooks** must carry `x-ogc-bridge-signature: t=<unix>,v1=<hex>` over the exact raw body
  (a raw-body parser is mounted only on the webhook route, 64 KB limit). Missing, malformed,
  forged or stale (older than `BRIDGE_WEBHOOK_TOLERANCE_SECONDS`) signatures get a uniform
  `401 WEBHOOK_REJECTED` and an audit event without the body.
- **Replay protection.** Each provider event is stored once (unique provider + event ID);
  duplicates are ignored. Events for unknown calls are ignored.
- **Idempotent start.** Unique (caller, idempotency key): a retried request returns the same
  call and never dials twice. A per-caller advisory lock serialises the concurrency and daily
  limit checks.
- **Timeouts.** A sweep every 15 seconds ends calls past `BRIDGE_MAX_CALL_SECONDS` and fails
  calls the provider never acknowledged (after 2 minutes).
- **Provider outage.** A failed `startCall` marks the call `FAILED` (`PROVIDER_UNAVAILABLE`);
  nothing is charged.

## Billing ledger

- Amounts are integer **minor units** (`BigInt`), never floating point.
- `bridge_tariffs`: per country and E.164 prefix (longest prefix wins), per-minute rate and
  billing increment. **No tariffs are shipped**: real rates come from the provider contract.
- A completed, non-simulated call with a positive duration and a tariff gets exactly one
  `CHARGE` entry (`externalRef = charge:call:<id>`, unique), so webhook retries cannot double
  charge. Simulated, zero-length, unanswered and failed calls are never charged.
- Staff adjustments and refunds are separate audited entries; entries are never edited.
- Before a live call starts, the maximum possible price (max duration × tariff) must fit in
  the account's remaining daily cap (`BRIDGE_DAILY_SPEND_LIMIT_MINOR`, default `0`).
- No payment collection is integrated. Charges are recorded, not collected.

## Data model (migration `20261016120000_ogc_bridge`)

Purely additive: new enums, new tables and new `AuditEventType` values. No existing table,
column or row is changed, so existing users and call records are unaffected and rollback of
the code needs no schema change (the tables simply stay unused).

| Table                  | Holds                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `bridge_numbers`       | Linked numbers (E.164, country, verified/revoked, opt-in, consent time). |
| `bridge_verifications` | Code hash, expiry, attempts, delivery, consumption.                      |
| `bridge_calls`         | Caller, callee, provider and IDs, status, timestamps, duration, reason.  |
| `bridge_call_events`   | Each accepted provider event once (replay protection, audit trail).      |
| `bridge_tariffs`       | Operator-entered rates per country and prefix.                           |
| `bridge_usage_entries` | Append-only ledger: charges, refunds, adjustments.                       |

Database `CHECK` constraints enforce E.164 format, country and currency codes, non-negative
counts and durations, caller ≠ callee, and the sign of each ledger entry kind.

## Inbound calls (design only, not implemented)

Calling **from** a telephone **to** an OGC member is not implemented and stays disabled.
It needs a provider-allocated inbound number (DID) per country, a regulatory basis for
offering it, and one of:

1. **Forwarding to the member's own linked phone** (simplest; still PSTN, not E2EE): the
   provider webhook asks OGC where to route; OGC answers with the linked number only if the
   member opted in, the caller is allowed, and limits permit.
2. **Answering inside the app**, which requires a provider voice SDK or SIP/WebRTC gateway in
   the web and mobile apps and a separate security review (it would add a new media path).

Either way: caller ID is untrusted, inbound routing must not reveal which account owns a
number, and the same signed-webhook, replay and rate-limit rules apply.
