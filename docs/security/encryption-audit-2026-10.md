# Messaging encryption audit (October 2026)

Scope: the encryption that protects OGC direct messages, groups, attachments and calls, as
implemented at commit `853a29e` plus this phase's working-tree changes. Method: reading the
source, the dependency manifests and the existing tests, and adding tests where a claim was
unproven. This is an internal engineering audit, **not** an independent cryptographic review.

## 1. What OGC actually uses

| Layer                                      | Implementation (exact versions)                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group key agreement and message protection | **MLS (RFC 9420)** via `ts-mls` 1.6.4 — not Signal's X3DH / Double Ratchet. Direct conversations are two-member MLS groups.                                                                                                                                |
| Ciphersuite                                | `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519` (0x0003) only; anything else is refused (`packages/e2ee/src/provider.ts`).                                                                                                                           |
| Primitives                                 | `@noble/hashes` 2.0.1, `@noble/curves` 2.0.1 (Ed25519), `@noble/ciphers` 2.1.1 (ChaCha20-Poly1305, XChaCha20-Poly1305); HPKE from `@hpke/core` 1.9.0, `@hpke/dhkem-x25519` 1.8.0, `@hpke/chacha20poly1305` 1.8.0. No algorithm is implemented in OGC code. |
| Hermes (React Native)                      | `kdf-subtle-shim.ts` provides only HMAC-SHA-256 and HKDF-SHA-256 `deriveBits` to `@hpke/core`, backed by `@noble/hashes`, tested byte-for-byte against WebCrypto. All other `crypto.subtle` calls are rejected.                                            |
| Device identity                            | Each MLS leaf is one device with a _basic_ credential `ogc-device/v1/<OGC ID>/<device key ID>` and an Ed25519 signature key registered with the server.                                                                                                    |
| Attachments                                | Per-file random 256-bit key, XChaCha20-Poly1305 with a fixed AAD; key, nonce and SHA-256 of the ciphertext travel inside the MLS message.                                                                                                                  |
| Local storage                              | Everything sensitive on a device (MLS state, private key packages, decrypted history) is sealed: XChaCha20-Poly1305 with a keystore-held key on mobile (`expo-secure-store`); a non-extractable AES-256-GCM `CryptoKey` in IndexedDB on web.               |
| Calls                                      | WebRTC DTLS-SRTP media; signaling (SDP, ICE) relayed by the OGC server.                                                                                                                                                                                    |
| Safety numbers                             | Signal-style numeric fingerprint (iterated SHA-512 × 5200), 60 digits, covering **every** device key of both accounts.                                                                                                                                     |

Post-quantum: `ts-mls` 1.6.4 also ships draft ML-KEM, X-Wing (X25519 + ML-KEM-768) and
ML-DSA suites. **OGC does not use them**, and nothing in OGC is post-quantum today.

## 2. Where plaintext and keys exist

| Data                                                                | Where it exists in plaintext                                              | Leaves the device?                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message text, reply quotes, attachment keys                         | Sender's and recipients' devices, in memory and in the sealed local store | Only as MLS ciphertext                                                                                                                                                           |
| Attachment content                                                  | Devices (in memory while encrypting / viewing)                            | Only as XChaCha20-Poly1305 ciphertext                                                                                                                                            |
| Device signing private key, private key-package halves, MLS secrets | The device's sealed store                                                 | **Never** (verified: only `publicKey` / public key packages are uploaded, `client.ts` `registerDeviceKey`, `replenishKeyPackages`)                                               |
| Push notification text                                              | Server and push provider                                                  | Fixed strings only ("New message", "Incoming call"); sender name only if the user allows previews; never message content (`notifications.service.ts`)                            |
| Logs                                                                | API                                                                       | Request bodies and query strings are never logged; ciphertext, plaintext, private keys, welcomes, group info, key packages, tokens and secrets are redacted (`logger.config.ts`) |
| Telemetry / crash reports                                           | —                                                                         | No third-party analytics or crash SDK is a dependency of any app or package                                                                                                      |
| Community channel posts                                             | Server                                                                    | **Yes, by design**: channels are not end-to-end encrypted and are labelled as such                                                                                               |

## 3. Threat model and findings

Legend: **V** verified (code + test), **G** gap, **U** uncertain / needs testing,
**M** would need a protocol migration.

### Malicious or compromised server

- **V** Cannot read direct or group messages or attachments: only ciphertext and public MLS
  data are stored (`messaging.e2e.test.ts` scans every stored byte for the plaintext).
- **V** Cannot forge or alter a message undetected: MLS application messages are
  authenticated (AEAD + sender signature). _Added this phase:_ a bit flipped in the header,
  body or tag, or a truncated message, is rejected without harming the group state
  (`mls.test.ts`), and a ciphertext altered **in the server database** is shown to the
  recipient as undecryptable — never as altered text — while the next message still arrives
  (`messaging.e2e.test.ts`).
- **V** Cannot re-use a ciphertext under another message ID (message ID bound into the AAD) or
  make a device decrypt the same ciphertext twice (keys are deleted after use).
- **V** Cannot substitute a member's leaf key behind the directory: members only accept leaves
  whose signature key equals the directory entry for that device (`mls.ts`
  `validateCredential`).
- **G** _The directory itself is server-controlled_ (basic credentials, no independent identity
  certificate). A malicious server could publish a rogue device for an account and add it.
  Detection relies on key-change warnings and safety numbers:
  - **V** direct conversations: trust-on-first-use key tracking flags any new device key and
    clears a previous "verified" mark (`key-tracking.ts`);
  - **G** **groups have no automatic key-change warning** (members can only verify each person
    manually from group info).
- **V/G** Can still see **metadata**: who talks to whom and when, message sizes, group
  membership, reply/forward links, attachment counts, mentioned OGC IDs (for notifications),
  **reaction types** (sent as plain values), presence, typing, receipts, and call times.
- **G** Can withhold, delay or reorder delivery (availability is not protected).
- **G** **Calls are not end-to-end authenticated**: DTLS fingerprints travel through the
  server and are not bound to MLS identities, so a malicious server could intercept call
  media. Already documented; calls are not described as end-to-end encrypted.

### Network interception and tampering

- **V** Message content is end-to-end protected regardless of transport.
- **U** Transport security of the deployed site (HTTPS, HSTS, CSP) depends on the production
  edge configuration; local development uses plain HTTP and is **not** production-secure.
  Browsers refuse Web Crypto on plain-HTTP network addresses — OGC now says so instead of
  showing an empty chat list (this phase).

### Account takeover and stolen devices

- **V** A new device signed in with a stolen password gets a new device key and **cannot read
  history** sent before it joined (`messaging.e2e.test.ts`, "reads only messages sent after it
  joined"); it does trigger key-change warnings for direct-conversation partners.
- **V** Signing out or revoking a device removes it from its groups so it cannot read new
  messages ("removes a logged-out device from the group").
- **G** No second factor; email is the recovery factor (documented).
- **U** A stolen, unlocked device with its session can read everything on it: protection rests
  on the platform keystore and device lock. Not tested on physical devices.

### Compromised endpoints, malware, web script injection

- **G** End-to-end encryption cannot protect against malware or a malicious script on the
  device itself. On web, injected script could use the non-extractable sealing key while the
  page is open (it cannot export it); CSP and text-only rendering mitigate this.
- **G** Secure erasure is **not** guaranteed in JavaScript or React Native (copies may remain in
  memory or engine heaps). `wipe()` clears buffers OGC controls; it is best effort.

### Replay, duplication, ordering

- **V** Server de-duplicates retried submissions (`clientMessageId`), assigns a per-conversation
  sequence and rejects replayed/stale MLS commits (compare-and-set on the epoch).
- **V** MLS rejects re-decryption of a used generation; replay under another ID fails the AAD.
- **U** Behaviour under heavy out-of-order delivery within an epoch is bounded by `ts-mls`
  retention settings; not stress-tested.

### Group membership changes

- **V** Removed or departed devices cannot read later epochs; external joins by devices missing
  from the directory are rejected.
- **G** No automatic group-level warning when a member gains a device (see above).

### Attachments, voice messages, call signaling

- **V** Attachments and voice messages are encrypted on the device; the server serves
  ciphertext only to participants; the ciphertext digest is checked before decryption.
- **G** Call signaling is visible to the server and not identity-bound (see above).

### Backups, notifications, logs, telemetry, crash reports

- **V** No server-side message backup exists: history lives only on devices (losing every device
  loses history; verification state is per device).
- **V** Notifications, logs and telemetry: see §2.

### Multi-device and device removal

- **V** Every device is its own MLS leaf; new devices join by external commit or Welcome and
  read only from their join onward.
- **V** Device sign-out and "sign out all other devices" end sessions immediately (verified in
  this phase's acceptance tests: the other device's token is rejected with 401).

### Disappearing messages and offline devices

- **G** **Disappearing messages are not implemented.**
- **V** Offline devices catch up in order on reconnection; queued sends are flushed once.

## 4. Changes made in this phase (no protocol change)

1. Tests proving rejection of tampered and truncated MLS application messages, at the protocol
   layer and end to end against a live API whose stored ciphertext was altered.
2. Web: secure messaging now explains an insecure page (no Web Crypto) instead of failing
   silently; tested.
3. Web: the session refresh is sent with `keepalive`, reducing session loss — and the erasure of
   that browser's encrypted history — when a page changes during a refresh; tested. A complete
   fix needs the server-side grace window in §5.

## 5. Staged plan

**Stage 1 — no protocol change (can proceed after review):**

1. Group key-change warnings: reuse the trust-on-first-use tracker per group member device, with
   a banner and per-member verification. Client-only.
2. Verification UX: QR-code safety-number comparison in addition to digits.
3. Refresh-token rotation grace: accept the immediately previous refresh token once, for a few
   seconds, instead of revoking the session. **Needs a database migration** (previous hash and
   rotation time on `sessions`) — requires approval.
4. Security tests to add: removed-device attempts to post, expired key packages offered by the
   server, key change during an active conversation (warning shown, no message loss).

**Stage 2 — new features (design review first):**

1. Disappearing messages: per-conversation timer carried inside the encrypted payload, local
   deletion on every device, and honest limits (screenshots, other devices that are offline,
   copies the recipient made, no guaranteed memory erasure).
2. Optional encrypted backup of history to a user-held key (cryptographic design review needed).

**Stage 3 — protocol migrations (each needs explicit approval and a migration plan):**

1. **Calls bound to identities:** carry the DTLS fingerprints (or an SFrame/insertable-streams
   key) inside the MLS group so a server cannot intercept media. Changes call signaling for all
   clients; old and new clients must not interoperate silently.
2. **Post-quantum key establishment:** move new groups to the X-Wing hybrid suite
   (`MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519`). MLS suites cannot be mixed in a group, so
   existing groups must be re-created; the suites come from IETF drafts, `ts-mls` is unaudited,
   ML-KEM performance on Hermes is untested, and key packages grow by kilobytes. Until done,
   OGC must not claim post-quantum security.
3. **Independent identity:** X.509 or other non-basic credentials, or key transparency, so the
   server cannot silently add devices.

**Before production regardless:** an independent review of `ts-mls` and OGC's MLS integration
(already listed as a release blocker in `security-review.md`), and testing of the Hermes shim,
keystore and calls on physical devices.
