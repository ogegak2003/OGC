# Encryption in groups and channels

How Phase 4 extends Phase 3 end-to-end encryption ([encryption.md](encryption.md)) to groups
and private encrypted channels, and what it does **not** protect. Decision: ADR-033.

## Two privacy models, never mixed

|                       | Groups and private encrypted channels                                | Community channels                        |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| Content               | end-to-end encrypted with MLS (RFC 9420, `ts-mls`, suite 0x0003)     | readable by OGC                           |
| Attachments           | encrypted on the device (XChaCha20-Poly1305, key inside the message) | stored server-readable; images re-encoded |
| Search                | on the device only                                                   | server-side                               |
| Moderation of content | only what a reporter discloses; admins remove messages               | moderators read posts                     |
| Label in apps         | "End-to-end encrypted"                                               | "Not end-to-end encrypted"                |

A channel never switches between these models.

## Membership and keys

- One MLS group per conversation; each **device** is a leaf. Eligible devices: the 4 newest
  active devices of each current member (≤ 32 members → ≤ 128 leaves).
- Every client checks every member of every new epoch against the server's device directory
  (OGC ID ↔ signature key), so the server cannot add a device without clients noticing a
  mismatch; the delivery service independently refuses trees containing anything else.
- **Joining:** existing members' devices commit `Add` proposals (Welcome for the newcomer), or
  the newcomer's device joins by external commit. History before the join is not available
  to them.
- **Removal / leaving:** the server records which accounts are in the tree after each commit
  and refuses new messages while a former member is still in it (`MLS_MEMBERSHIP_STALE`). The
  next sender's device commits `Remove` proposals first; MLS then derives fresh epoch secrets
  that the removed devices cannot compute. Tested with real cryptography: a removed member
  with a saved copy of their old state, plus every commit and ciphertext on the server, cannot
  decrypt the next message.
- **Replay / staleness:** commits are accepted once per epoch (compare-and-set); application
  messages must carry the current epoch and AAD bound to their client message ID; edits use a
  separate AAD with the revision number.

## Multi-device

New devices of a member are added by any member's device on the next send or on
`devices.changed`. Each device keeps its own MLS state and local, sealed message store. A
device that falls too far behind re-joins by external commit and shows earlier messages as
unavailable.

## Limitations (stated plainly)

- Metadata is visible to OGC: who is in which group, roles, names, photos, timing, sizes,
  reaction types and declared mentions.
- New members can't read earlier messages; a member's 5th and later devices can't join.
- Removing someone cannot recall what they already decrypted, exported or screenshotted.
- Deleting a group or message for everyone reaches devices that sync; it cannot reach copies
  outside OGC.
- `ts-mls` and the OGC integration have **not had an independent security audit**; that is a
  production prerequisite.
- Safety numbers in groups are compared per member pair; there is no group-wide fingerprint.
