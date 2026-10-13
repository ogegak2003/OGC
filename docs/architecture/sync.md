# Synchronization (offline, reconnect, multi-device)

Decision: [ADR-025](decisions.md#adr-025-per-conversation-change-counter-for-synchronization).
Status: **Implemented** unless marked otherwise.

## Principle

PostgreSQL is the source of truth; WebSocket events are only a hint that something changed.
Every device keeps a **cursor per conversation** and pulls an ordered change log after it, so
a disconnected, sleeping or brand-new device converges without relying on the socket.

## The change counter

Each conversation has a `version` counter. Every change takes the next value inside the
change's transaction:

```sql
UPDATE conversations SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version
```

The `UPDATE` locks the conversation row until commit, so **versions become visible strictly in
commit order** — a reader that sees version _v_ has also seen every change ≤ _v_. That makes a
simple `version > cursor` query complete, with no gaps from in-flight transactions.

| Change                        | Stored as                                         |
| ----------------------------- | ------------------------------------------------- |
| New message                   | `messages.seq = messages.version = v`             |
| Edit, delete, reaction change | `messages.version = v` (position `seq` unchanged) |
| MLS commit                    | `mls_commits.version = v`                         |
| "Delete for me" (per user)    | `message_hides.version = v`                       |

Per-conversation (not global) counters were chosen because a global sequence is not
commit-ordered under concurrency (a later-committing transaction can hold a smaller number),
and a per-user inbox log would require one write per recipient. The cost — the row lock
serialises writes per conversation — is negligible for DIRECT conversations and acceptable for
groups of moderate size (to be revisited for very large groups).

## Pulling changes

`GET /conversations/:id/sync?after=<cursor>&limit=≤200` returns, in version order:
`message` items (full envelope incl. ciphertext and reactions), `commit` items (MLS handshake
needed to keep decrypting) and the caller's own `hidden` items. The server first reads the
conversation's version as a snapshot bound, so pages are consistent; `version` in the response
is the new cursor and `hasMore` drives paging. Messages withheld from or hidden by the caller
are excluded; the cursor still advances past them.

The engine processes items strictly in order under a per-conversation lock (MLS state is a
state machine), persisting group state after every decryption and the cursor after every
page. Re-processing is idempotent (messages are matched by client message ID and revision).

## Finding conversations to sync

`GET /conversations/changes?since=<cursor>` lists the caller's conversations by
`(updated_at, id)`. At the frontier the cursor stays 10 s behind "now", so a transaction that
commits late with an earlier timestamp is never skipped; re-sent conversations are harmless
because clients compare `version` with their own cursor.

## Scenarios

| Scenario                          | What happens                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Socket drops briefly              | Reconnect → `syncAll()` (changes feed → per-conversation sync) → outbox flush                |
| Device offline for days           | Same; paging through ≤ 200 changes per request                                               |
| Mobile app returns to foreground  | `syncAll()` on `AppState` "active"                                                           |
| Web + mobile simultaneously       | Each device has its own MLS leaf, cursor and sealed store; both receive realtime events      |
| Message sent from my other device | Decrypted normally (it is another group member); my own device uses its stored plaintext     |
| New device / new login            | Joins via Welcome or external commit; earlier messages show "Sent before this device joined" |
| Lost local store                  | Treated as a new device (new identity key; old one revoked)                                  |
| Send while offline                | Stored as `pending`; retried with the same client message ID; never duplicated               |
| Send against an old epoch         | `409 STALE_EPOCH` → sync commits → re-encrypt → retry (bounded)                              |

## Limits and planned work

- **History for new devices** — Planned: encrypted history transfer from an existing device.
- **Local store growth** — no retention limit yet; Planned: per-conversation local pruning.
- **Delivery receipts** are per account ("delivered to at least one device"), not per device.
