# End-to-end encryption

Status legend: **Implemented** · **Partially implemented** · **Planned**.

OGC private messages are end-to-end encrypted with **MLS (Messaging Layer Security,
RFC 9420)** between **devices**. The server stores and routes ciphertext and the public MLS
data needed to operate (key packages, commits, GroupInfo); it never holds message keys or
plaintext. Decisions: [ADR-024](decisions.md#adr-024-end-to-end-encryption-with-mls-rfc-9420-via-ts-mls),
[ADR-027](decisions.md#adr-027-attachments-are-encrypted-on-the-device).

> **Read this first — honest status.** The protocol, key management and delivery-service
> policy are implemented and tested end to end (real cryptography, real API, real database).
> Two things stand between this and a production security claim: the MLS library
> (`ts-mls`) **has not had an independent security audit**, and the OGC integration itself
> has not been externally reviewed. Both are listed as production prerequisites. OGC must
> not be marketed as "unbreakable" or "perfectly private" — see
> [Security properties](#security-properties) for what is actually provided.

## Library evaluation (October 2026)

| Option                                           | Protocol                             | Platforms                                              | Licence    | Maintenance / review                                                                                                               | Verdict                                                                    |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@signalapp/libsignal-client`                    | Signal (X3DH/PQXDH + Double Ratchet) | Node native binaries only; no browser, no React Native | AGPL-3.0   | Maintained by Signal; "use outside of Signal is unsupported"                                                                       | Rejected: no web/mobile build, AGPL, unsupported outside Signal            |
| `@privacyresearch/libsignal-protocol-typescript` | Signal                               | Pure TS                                                | GPL-3.0    | Community port, little recent activity                                                                                             | Rejected: stale, copyleft                                                  |
| `vodozemac` (Matrix Olm/Megolm)                  | Olm / Megolm                         | Rust; JS only via Matrix SDK WASM wrappers             | Apache-2.0 | Maintained, audited (2022)                                                                                                         | Rejected for now: no standalone npm/React Native binding; Megolm lacks PCS |
| OpenMLS                                          | MLS RFC 9420                         | Rust; WASM build needed, no React Native binding       | MIT        | Maintained, widely used                                                                                                            | Strong candidate later (would need our own WASM/RN bindings)               |
| **`ts-mls` 1.6.4**                               | **MLS RFC 9420**                     | **Pure TypeScript: browsers, Node, Hermes**            | **MIT**    | Active (releases Aug 2026, `2.0` RC); passes the official MLS interop vectors; **not audited**; GHSA-gwp3-968w-m7gv fixed in 1.6.4 | **Selected**                                                               |

Why MLS: it is the IETF standard for asynchronous group messaging, handles **multi-device as
group membership** (each device is a leaf), and gives forward secrecy and post-compromise
security. One-to-one conversations are two-person groups, so groups (Phase 4) reuse the same
machinery instead of a second protocol. Why `ts-mls`: it is the only maintained,
permissively-licensed RFC 9420 implementation that runs unmodified on all three OGC runtimes.
Its primitives are the audited `@noble/*` libraries and `hpke-js`.

## What is implemented

| Area                                                                                   | Status                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| MLS ciphersuite `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519` (0x0003)         | Implemented                                           |
| Per-device Ed25519 identity keys, generated on the device                              | Implemented                                           |
| Key packages (one-time, 90-day lifetime, signature-verified by the server)             | Implemented                                           |
| Group creation, adding devices (Welcome), external join, device removal                | Implemented                                           |
| Delivery-service policy (server-side checks of commits without decrypting)             | Implemented                                           |
| Application-message encryption with authenticated data binding                         | Implemented                                           |
| Authenticated sender (from the MLS tree, never from server metadata)                   | Implemented                                           |
| Encrypted attachments (XChaCha20-Poly1305, key inside the MLS message)                 | Implemented                                           |
| Sealed local storage (web: non-extractable AES-GCM key; mobile: Keychain/Keystore key) | Implemented                                           |
| Safety numbers                                                                         | Implemented (manual compare; no "verified" state yet) |
| Key-change warnings in the UI                                                          | Planned                                               |
| Encrypted history transfer to a new device of the same person                          | Planned                                               |
| Encrypted backup / account recovery of message history                                 | Planned                                               |
| Post-quantum ciphersuite (X-Wing)                                                      | Planned (supported by `ts-mls`)                       |
| Independent audit of `ts-mls` and of OGC's integration                                 | **Required before production**                        |

## Identities and keys

Four separate kinds of secret, never derived from each other:

| Secret                          | Where it lives                                             | Purpose                                                |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Password                        | Only its Argon2id hash on the server                       | Signing in (authentication only)                       |
| Session tokens                  | Hashes on the server; cookie (web) / secure store (mobile) | API access                                             |
| Device signature key (Ed25519)  | **Only on the device**, sealed at rest                     | MLS credential: proves "this is device D of account A" |
| MLS group secrets, key packages | **Only on the device**, sealed at rest                     | Message encryption (rotated every epoch)               |

- **Account identity** is the OGC ID. **Device identity** is a random device key ID plus the
  device's Ed25519 public key, registered with `PUT /e2ee/device-key` and stored in
  `device_keys`. The MLS credential is `ogc-device/v1/<OGC ID>/<device key ID>`.
- A device key is **active** while its device has a live session. Logging out revokes it
  (`session.revoked` → device key revoked, unused key packages and pending Welcomes deleted,
  push token removed). Expired sessions make it inactive automatically.
- If a device loses its local store, it registers a new key; the old one is revoked and
  removed from groups.
- Passwords are never used to derive keys. Resetting a password (when added) grants no access
  to message history.

## Sessions: how two devices start talking

1. Every device keeps ≥ 10 unused **key packages** on the server (topped up to 30). The
   server verifies each one: valid signatures, the OGC ciphersuite, unexpired, and a
   credential naming exactly the uploading account, device key and registered signature key.
2. The first device to send in a conversation **creates the MLS group** (epoch 0), claims one
   key package per active device of both participants (`POST /conversations/:id/mls/key-packages`,
   each package handed out once) and commits them, producing a **Welcome**. The server stores
   the Welcome for each added device.
3. Devices fetch their Welcomes (`GET /e2ee/welcomes`), join, and acknowledge.
4. A device that is not in the group and has no Welcome (e.g. a new login while every other
   device is offline) performs an **external join** (RFC 9420 §12.4.3.2) using the GroupInfo
   that members publish with every commit.

## Delivery-service policy (server-enforced, without decryption)

Commits are sent as MLS **PublicMessages**, so the server can check them. For every commit:

- exactly one commit is accepted per epoch (compare-and-set on `conversations.mls_epoch` and
  the `(conversation, epoch)` primary key); concurrent commits get `409 STALE_EPOCH`;
- the committer must be the submitting device (member leaf, or the joiner of an external commit);
- **every member of the resulting group must be an active device of one of the two
  participants**, with its registered signature key;
- a device may only be removed if it is no longer active or belongs to the committer;
- added devices must use a key package they published and that was claimed;
- the Welcome must address exactly the added key packages;
- the new GroupInfo must be validly signed and for the next epoch.

Application messages are checked by their cleartext MLS header: right group, current epoch
(stale epochs are rejected so no device is silently left out), and authenticated data equal
to `ogc-msg/v1/<conversation>/<client message id>` (edits: `ogc-edit/v1/…/<revision>`). The
AAD is also checked by recipients, so the server cannot replay ciphertext under another
message ID or conversation.

## Trust model

- **The server is trusted to route and to publish the device directory, not to read.** It
  cannot decrypt messages, attachments or previews.
- **Directory trust.** Clients authenticate every group member against the directory
  (`GET /conversations/:id/devices`) — devices must be listed with the same signature key and
  account. A malicious server could list a device it controls as one of yours; that is
  exactly what **safety numbers** detect (they change whenever a device is added). Until users
  compare them, OGC offers the same "trust on first use" as other multi-device messengers.
- **Metadata the server sees** (by design, needed to operate): who talks to whom, when,
  message sizes and counts, which devices each account has, reaction types (a fixed set of
  six), delivery/read positions, attachment sizes and declared kinds, presence and typing
  events. It does **not** see message text, attachment content or names, reply/forward
  content, or previews.

## Key rotation and device changes

- Every commit (device added/removed, external join) starts a new **epoch** with fresh
  secrets; old message keys are deleted after use (`wipeConsumed`). Receivers retain keys for
  at most 4 past epochs and 10 skipped generations (library defaults) to tolerate reordering.
- **Device addition:** member devices reconcile membership before sending (a fresh directory
  fetch) and on `devices.changed` events; new devices are added with a Welcome or join
  externally. A new device cannot read messages sent before it joined — they show as
  "Sent before this device joined".
- **Device removal:** logout revokes the key immediately (no further API access); the next
  member device to reconcile removes it from the MLS group, after which it cannot decrypt new
  messages even if its stored secrets were stolen.
- **Periodic self-update** (post-compromise healing without membership changes): Planned.

## Safety verification

`safetyNumber()` follows Signal's numeric-fingerprint construction (iterated SHA-512, five
digits per five bytes) over each account's OGC ID and the sorted signature keys of all its
devices; both people see the same 60 digits in 12 groups. Implemented on web and mobile
("Verify"). Persisting a "verified" state and warning when it changes: Planned.

## Local storage

All engine state — identity key, key-package private keys, MLS group state, decrypted
messages — passes through `SealedStore`, which seals every record (AEAD, record name as
associated data):

- **Web:** IndexedDB database per account; sealing key is a **non-extractable** AES-256-GCM
  `CryptoKey` stored in IndexedDB (usable by the page, never readable). Nothing in
  localStorage. Signing out deletes the database.
- **Mobile:** one file per record in the app's private documents directory; sealing key is a
  random 256-bit key in the iOS Keychain / Android Keystore via `expo-secure-store`
  (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Signing out deletes the files and the key.

Limitation: script running in the page (e.g. via an XSS bug) could use the web key while the
page is open; the strict CSP (no inline script, `connect-src 'self'`) is the mitigation.

## React Native (Hermes)

Hermes has no WebCrypto. The mobile app installs, before anything else
(`apps/mobile/src/crypto-setup.ts`): `crypto.getRandomValues`/`randomUUID` from the platform
CSPRNG (`expo-crypto`), and `installSubtleKdfShim()` — a **narrow** SubtleCrypto providing
only HMAC-SHA-256 and HKDF-SHA-256 (the only operations `hpke-js` needs), backed by
`@noble/hashes` and tested byte-for-byte against WebCrypto. Every other SubtleCrypto call
fails loudly. A test runs the full MLS flow with WebCrypto removed. **Not yet verified on a
physical device** (bundling is verified by `expo export`).

## Security properties

| Property                                                  | Provided?                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| Server cannot read message or attachment content          | Yes                                                              |
| Messages authenticated to a specific sender device        | Yes (MLS signatures, sender from the ratchet tree)               |
| Forward secrecy (past messages safe after key compromise) | Yes, per epoch/generation (MLS)                                  |
| Post-compromise security                                  | After the next commit; periodic updates Planned                  |
| Removed devices cannot read new messages                  | Yes (after the removing commit)                                  |
| Protection against a malicious server adding a device     | Detectable via safety numbers (manual); no automatic warning yet |
| Deletion from devices that already displayed a message    | Best effort only — see [messaging.md](messaging.md#deletion)     |
| Metadata privacy (who/when)                               | No — visible to the server                                       |
| Independently audited                                     | **No**                                                           |
