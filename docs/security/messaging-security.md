# Messaging security

Controls for private messaging, realtime and end-to-end encryption (Phase 3). Architecture:
[messaging.md](../architecture/messaging.md), [encryption.md](../architecture/encryption.md),
[realtime.md](../architecture/realtime.md), [sync.md](../architecture/sync.md).

## Authorization rules

1. Every REST route and every realtime connection requires an ACTIVE account's session.
2. Identity (user, device, session) comes only from the verified session — never from
   request bodies or socket payloads.
3. Conversation access is decided in one place (`ConversationAccessService`): the caller must
   be a participant; everyone else gets the same 404 as for an unknown ID.
4. Messages, attachments, receipts, reactions, commits and Welcomes are always looked up
   **through** a conversation the caller participates in, or scoped to the caller's device.
5. Request bodies and socket payloads are strict Zod schemas (unknown fields rejected).
6. Encryption-related writes require an active device key for the calling device.

## Threats and controls

| Threat                                     | Control                                                                                                                                                                               | Verified by                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Server or DB compromise reads messages     | MLS end-to-end encryption; only ciphertext stored; attachments encrypted on device                                                                                                    | `messaging.e2e.test.ts`, `mls.test.ts`, Docker E2E                |
| Plaintext in logs / analytics / audit      | No bodies logged; redaction of `ciphertext`, `plaintext`, `privateKey`, `welcome`, `groupInfo`, key packages; metrics use enum labels only; audit metadata is IDs only                | `messaging-operations.test.ts`, Docker E2E (log scan)             |
| IDOR / conversation or message enumeration | Participant-scoped queries; identical 404s; random UUIDv4 conversation and attachment IDs                                                                                             | `messaging.e2e.test.ts` ("no IDOR")                               |
| Duplicate DIRECT conversations             | Unique `direct_key`; race returns the winner                                                                                                                                          | `database.test.ts`, e2e                                           |
| Duplicate submissions / replay             | Unique `(sender, client_message_id)`; AAD binds ciphertext to its message ID and revision; MLS reuse guard and key deletion                                                           | e2e "idempotency", `mls.test.ts` (AAD, replay)                    |
| Cross-conversation replies                 | API check + composite foreign key                                                                                                                                                     | e2e, `database.test.ts`                                           |
| Unauthorized edits / deletes               | Sender-only, time windows, compare-and-set on revision                                                                                                                                | e2e                                                               |
| Forged receipts                            | Receipts only advance the caller's own marks, never beyond the conversation; never across blocks                                                                                      | e2e, realtime tests                                               |
| Unauthorized reactions                     | Participant-only, fixed set (CHECK), one per type per user (PK)                                                                                                                       | e2e, `database.test.ts`                                           |
| Forwarding unreadable content              | Server checks the caller can read the source; content re-encrypted on device                                                                                                          | e2e "forwards"                                                    |
| Blocked-user communication                 | Blocker cannot send; blocked user's messages withheld silently; no typing/presence/receipts across blocks                                                                             | e2e "withholds", realtime "block" test                            |
| Device impersonation                       | Key packages verified (signatures, credential = uploading device + registered key); one active key per device; keys unique across devices                                             | `mls-policy.test.ts`                                              |
| Malicious member adds a foreign device     | Delivery service rejects any group state containing a non-participant or inactive device                                                                                              | `mls-policy.test.ts`                                              |
| Member removes the other person's devices  | Only inactive or own devices may be removed                                                                                                                                           | `mls-policy.test.ts`                                              |
| Stale or forked group state                | One commit per epoch (CAS + PK); stale-epoch messages rejected                                                                                                                        | `mls-policy.test.ts`                                              |
| Logged-out device keeps reading            | Logout revokes the key (no API access) and the next reconcile removes it from the MLS group                                                                                           | e2e "removes a logged-out device"                                 |
| Malicious server substitutes keys          | Safety numbers (manual comparison); automatic key-change warnings Planned                                                                                                             | `primitives.test.ts`, e2e                                         |
| XSS through messages                       | Text rendered as text only (React/React Native), never HTML; strict CSP; payload schema rejects unknown fields, control and bidi characters                                           | web/mobile UI tests, `messaging.test.ts` (validation)             |
| Malicious attachments                      | Ciphertext only on the server, served as `application/octet-stream` attachment, `nosniff`; recipients verify digest/size, sniff real image bytes (no SVG/HTML inline), sanitise names | e2e, web UI test ("disguised file")                               |
| Oversized payloads                         | JSON 100 kB (1 MB for MLS commits), ciphertext 64 KiB, handshake 128 KiB, attachments 10–25 MiB, socket payloads 16 KiB, DB CHECKs                                                    | e2e "oversized", `database.test.ts`                               |
| Spam / flooding                            | Configurable per-account limits for sends, conversations, attachments, reactions, edits, deletes, receipts, sync, typing, presence, socket connections; shared through Redis          | `messaging-operations.test.ts`, `redis-scaleout.test.ts`          |
| WebSocket abuse                            | Authenticated handshake, Origin allowlist, closed event set (unknown → disconnect), payload validation, per-account event limits, expiry and revocation disconnects                   | `realtime.test.ts`                                                |
| Cross-site WebSocket hijacking             | Cookie-authenticated sockets require an allowlisted Origin                                                                                                                            | `realtime.test.ts`                                                |
| CSRF                                       | REST unchanged (SameSite=Strict + client header); sockets via Origin check                                                                                                            | `auth.security.test.ts`, `realtime.test.ts`                       |
| Session abuse                              | Sockets closed at access-token expiry and on revocation; expired tokens rejected                                                                                                      | `realtime.test.ts`, `messaging-operations.test.ts`                |
| Push notification leakage                  | Generic "New message" only; tokens bound to the authenticated device, moved on re-registration, deleted at logout                                                                     | `messaging-operations.test.ts`, `push-provider.test.ts`           |
| Local data theft (lost device)             | Sealed local store; keys in Keychain/Keystore (mobile) or non-extractable WebCrypto (web); wiped at sign-out                                                                          | `idb-store.test.ts`, `native-store.test.ts`, `primitives.test.ts` |

## Never logged

Passwords, access/refresh tokens, private keys, plaintext message content, plaintext
attachment content — and, as defence in depth, not even ciphertext or MLS handshake data
(request bodies are not logged at all).

## Known limitations (security-relevant)

- `ts-mls` has **not been independently audited**; OGC's integration has not been externally
  reviewed. Required before production.
- Metadata (who, when, sizes, reaction types, presence) is visible to the server.
- Key-change warnings and a persisted "verified" state for safety numbers are not implemented.
- A web page compromised by XSS could use the non-extractable sealing key while open.
- Deletion cannot recall copies already saved, screenshotted or forwarded.
- Rate limits are per instance unless `REDIS_URL` is set (required in production).
- The Hermes crypto shim is unit-tested and simulated, not yet verified on a physical device.
