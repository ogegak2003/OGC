# Private messaging

Status legend: **Implemented** · **Partially implemented** · **Planned**. Related:
[encryption.md](encryption.md), [sync.md](sync.md), [realtime.md](realtime.md),
[messaging-security.md](../security/messaging-security.md), ADR-022 … ADR-030 in
[decisions.md](decisions.md).

## Scope (Phase 3)

| Capability                                                | Status                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| DIRECT (one-to-one) conversations between contacts        | Implemented                                                                                                                                          |
| End-to-end encrypted text, replies, edits, forwards       | Implemented                                                                                                                                          |
| Reactions (fixed set of six)                              | Implemented                                                                                                                                          |
| Delete for me / delete for everyone                       | Implemented                                                                                                                                          |
| Encrypted attachments: images, files, voice messages      | Implemented (video/audio files are sent as files; no inline video player)                                                                            |
| Delivery and read receipts, unread counts                 | Implemented                                                                                                                                          |
| Typing indicators, presence                               | Implemented (approximate by design)                                                                                                                  |
| Realtime delivery (WebSocket), offline sync, multi-device | Implemented                                                                                                                                          |
| Offline outbox with idempotent retries                    | Implemented                                                                                                                                          |
| On-device message search                                  | Implemented (linear scan of the local store)                                                                                                         |
| Push notifications                                        | Partially: backend, token registration API and Expo provider implemented; the mobile app does not yet request a push token (needs an EAS project ID) |
| Message requests from non-contacts                        | Planned                                                                                                                                              |
| Groups and channels                                       | Planned (Phase 4; MLS groups reuse the same core)                                                                                                    |
| Read-receipt / presence privacy settings                  | Planned                                                                                                                                              |

## Domain model

```text
Conversation (DIRECT, unique per pair) ──< ConversationParticipant (read/delivered high-water marks)
     │
     ├──< Message (seq, version, ciphertext, epoch, clientMessageId) ──< MessageEdit (metadata)
     │        ├──< MessageReaction (fixed set)          ├──< Attachment (ciphertext blob)
     │        └──< MessageHide ("delete for me")
     ├──< MlsCommit (one per epoch)      └──< MlsWelcome (per target device)
DeviceKey (per device) ──< KeyPackage        PushToken (per device)
```

- **Conversation IDs** are random UUIDv4 (no time leak) and double as the MLS group ID. A
  DIRECT conversation has a unique `direct_key` (`<smaller user id>:<larger user id>`), so two
  people can never have two independent conversations — even when both open one at the same
  moment. A trigger admits only those two users as participants. Groups add types later
  without changing messages (ADR-022).
- **Messages** use UUIDv7 IDs. `seq` is the message's position, `version` its last change;
  both come from the conversation's change counter (see [sync.md](sync.md)). Server
  timestamps (`created_at`) are authoritative; client clocks are never used for ordering.
- **Replies** use a composite foreign key `(conversation_id, reply_to_id) → messages
(conversation_id, id)`, so a reply can never point into another conversation — enforced by
  the database, not just the API.

## Message lifecycle

| State     | Meaning                                                                                 | Where           |
| --------- | --------------------------------------------------------------------------------------- | --------------- |
| CREATED   | Encrypted and stored in the device's outbox (`pending`)                                 | Device only     |
| SENT      | Accepted **and persisted** by the API (HTTP 201) — the only acknowledgement that counts | Server          |
| DELIVERED | Stored by at least one of the recipient's devices (`POST /conversations/:id/delivered`) | Participant row |
| READ      | Seen by the recipient (`POST /conversations/:id/read`)                                  | Participant row |

A realtime event is never an acknowledgement: sending goes through REST, delivery/read through
REST receipts. Receipts are **high-water marks** (`last_delivered_seq`, `last_read_seq`), not
one row per message, and never move backwards or beyond the conversation. Clients derive each
message's status (`messageStatus()` in `@ogc/messaging`). Receipts are not shared across a
block in either direction.

## Features and their semantics

### Idempotent sending

Every message carries a client-generated `clientMessageId` (UUID). `(sender, clientMessageId)`
is unique in the database: a retry after a lost response returns the original message, and a
concurrent duplicate loses the race to the constraint and gets the same answer. The engine
keeps unsent messages in a sealed outbox and retries them on reconnect ("pending"). Errors
that will not succeed on retry (4xx other than 429) mark the message "failed" (Retry/Discard).

### Editing

Sender only, within **48 hours**, not after deletion or across a block. The new ciphertext
is bound to `(conversation, clientMessageId, revision)`; concurrent edits are serialized by a
compare-and-set on the revision. The server keeps edit **metadata** (`message_edits`:
revision, device, time) — not old ciphertext — and clients show "edited".

### Deletion

- **Delete for me** hides the message on all of the caller's devices (`message_hides`,
  synced as a `hidden` change). Others are unaffected.
- **Delete for everyone** (sender only, within **48 hours**): the server erases the
  ciphertext, reactions and attachment blobs, keeps the fact that a message existed and was
  deleted (and an audit event), and every device erases its local plaintext.
- **What deletion cannot do:** recall copies already displayed and saved, screenshotted,
  exported, forwarded, or backed up outside OGC, or devices that never come online again. The
  UI says so before confirming.

### Reactions

Six fixed types (`thumbs_up`, `heart`, `joy`, `wow`, `sad`, `pray`), one of each type per
person per message (primary key), enforced by a CHECK constraint. Reaction types are visible
to the server (ADR-022); reactions by someone you blocked are hidden from you.

### Replies

`replyToId` must reference a visible message in the same conversation (API + composite FK).
The quoted text is rendered from the device's own decrypted copy; if that copy is unavailable
(deleted, before the device joined), clients show "Original message unavailable".

### Forwarding

The device decrypts the source, re-encrypts the content for the target conversation and
re-uploads attachments with fresh keys. The server checks only that the caller can currently
read the source message (`forwardedFromId`) and stores a `forwarded` flag — never the source
ID, original sender, or session. The recipient sees "Forwarded", not who wrote it.

### Attachments and voice messages

See [encryption.md](encryption.md) and ADR-027. Limits (plaintext): images and voice 10 MiB,
other kinds 25 MiB; voice up to 15 minutes. The server stores ciphertext under
`attachments/<uuid>.bin`, serves it only to participants (and, before sending, only to the
uploader), as `application/octet-stream` with `Content-Disposition: attachment`, and deletes
uploads not attached to a message within 24 hours. Recipients verify the digest and size,
show images inline only if the bytes are really JPEG/PNG/WebP/GIF (never SVG/HTML), sanitise
file names (paths, control and bidi characters) and offer other files as downloads.
Voice: web records with `MediaRecorder` (WebM/Opus or MP4/AAC), mobile with `expo-audio`
(AAC/M4A); permission denial and missing microphones are explained. Known limitation: iOS
cannot play WebM voice messages recorded in Chrome/Firefox (shown as "Unavailable").

### Blocking

| Situation        | Behaviour                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| You blocked them | You can't send/edit/react (`403 BLOCKED`); their messages after the block are withheld                                      |
| They blocked you | Sending "succeeds" (the block is not revealed) but the message is **withheld** — never delivered, not even after unblocking |
| Either way       | No typing, presence or receipts across the block; new conversations impossible (Phase 2 rules)                              |

### Unread counts and previews

Unread = messages after your read mark, from the other person, not deleted, withheld or
hidden (exact up to 1 000, shown as "999+"). The server provides **metadata only** for the
list (last message id/time/sender, deleted flag); the preview text is decrypted on the
device. The server never generates plaintext previews.

### Search

Implemented on the device over its decrypted local store (case- and Unicode-normalised
substring match of text and attachment names). There is no server-side search: the server
cannot read messages (ADR-030). Encrypted search indexes are not used.

## REST API (`/api/v1`, all authenticated)

| Method & path                                            | Purpose                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /conversations` `{ogcId}`                          | Open (201) or return (200) the DIRECT conversation with a contact |
| `GET /conversations?cursor&limit`                        | Conversations by latest activity (keyset, ≤ 100)                  |
| `GET /conversations/changes?since&limit`                 | Conversations changed since a cursor (reconnect / new device)     |
| `GET /conversations/:id`                                 | One conversation                                                  |
| `GET /conversations/:id/devices`                         | Encryption device directory of both participants                  |
| `GET /conversations/:id/messages?before\|after&limit`    | History by position (≤ 100)                                       |
| `POST /conversations/:id/messages`                       | Send (idempotent on `clientMessageId`)                            |
| `GET /conversations/:id/sync?after&limit`                | Ordered change log (messages, commits, hides; ≤ 200)              |
| `POST /conversations/:id/read` / `/delivered` `{seq}`    | Receipts (high-water marks)                                       |
| `GET /conversations/:id/mls`                             | Current epoch, GroupInfo, member device IDs                       |
| `POST /conversations/:id/mls/key-packages`               | Claim key packages for participant devices                        |
| `POST /conversations/:id/mls/commits`                    | Submit a commit (+ GroupInfo, Welcome)                            |
| `PATCH /messages/:id`                                    | Edit                                                              |
| `DELETE /messages/:id?scope=self\|everyone`              | Delete                                                            |
| `PUT` / `DELETE /messages/:id/reactions/:reaction`       | React / remove reaction                                           |
| `POST /attachments` (multipart) · `GET /attachments/:id` | Encrypted attachment upload / download                            |
| `PUT` / `GET /e2ee/device-key`                           | Register / inspect this device's encryption key                   |
| `POST /e2ee/key-packages`                                | Publish key packages                                              |
| `GET /e2ee/welcomes` · `DELETE /e2ee/welcomes/:id`       | Pending Welcomes for this device                                  |
| `PUT` / `DELETE /notifications/push-token`               | This device's push token                                          |
| `GET /metrics` (bearer `METRICS_TOKEN`)                  | Prometheus metrics (404 when not configured)                      |

Errors follow the existing envelope; new codes: `NOT_A_CONTACT`, `BLOCKED`, `STALE_EPOCH`,
`E2EE_DEVICE_REQUIRED`, `INVALID_MLS_MESSAGE`, `PAYLOAD_TOO_LARGE`. Non-participants get the
same `404` as for unknown IDs.

## Code map

| Concern                                              | Location                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| Crypto (MLS, attachments)                            | `packages/e2ee`                                                                |
| Client engine (sync, outbox, store, realtime client) | `packages/messaging`                                                           |
| Contracts and validation                             | `packages/types/src/messaging.ts`, `packages/validation/src/messaging.ts`      |
| API                                                  | `apps/api/src/modules/{conversations,e2ee,attachments,realtime,notifications}` |
| Web UI                                               | `apps/web/src/{messaging,components/messaging,pages/MessagesPage.tsx}`         |
| Mobile UI                                            | `apps/mobile/src/{messaging,screens/messaging}`                                |
