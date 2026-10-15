# Push notifications

Decision: [ADR-038](decisions.md#adr-038-push-notifications-durable-postgresql-queue-generic-content).
Status: **Implemented** for the mobile app's development and release builds (Expo push
service → FCM/APNs). **Not in Expo Go.** No browser push on the web (the in-app notification
center works while a page is open). Setup and testing: [development/notifications.md](../development/notifications.md).

## What a push is (and is not)

A push is only an **alert**. Messages stay end-to-end encrypted and are delivered by the
messaging system (stored ciphertext + sync); a lost, late or duplicate push never loses or
duplicates a message. Tapping a push opens the right screen, which then loads and decrypts the
content through the normal authenticated flow.

| Kind                  | Body (fixed text)                                                   | Opens                        |
| --------------------- | ------------------------------------------------------------------- | ---------------------------- |
| Direct message        | "New message"                                                       | The conversation             |
| Group / channel msg   | "New group message" / "New channel message"                         | The conversation             |
| Mention, invitations… | Fixed community texts ("You were mentioned", "New announcement", …) | Invitations / notifications  |
| Calls                 | "Incoming call" (high priority, 45 s lifetime) / "Missed call"      | The conversation (+ call UI) |
| Contacts              | "New contact request" / "Your contact request was accepted"         | Contacts                     |

The body comes from a closed set enforced by the type system (`PushBody`). The **title** is
"OGC", or — only if the recipient chose **sender previews** — the sender's display name (and
group name). **Message text, attachments, keys and tokens are never in a push.** Full previews
would need on-device decryption in a notification service extension (iOS) / background
handler (Android) — not implemented; the server cannot produce them by design.

## Pipeline

```
domain event ──▶ NotificationsService / CommunityNotificationsService
  (message.created, call.ringing/missed, contact.request.*, community notifications)
      │  recipients (never the sender), per-conversation level & mute, blocks already applied
      ▼
PushDeliveryService.enqueue
      │  ACTIVE accounts only · account settings (category on/off) · devices with a push token
      │  and a live session · skip devices with a live realtime connection (the app shows it)
      │  · sound/vibration from settings and quiet hours · INSERT … ON CONFLICT DO NOTHING
      ▼
push_deliveries (PostgreSQL)  ◀── worker on every API instance (PUSH_WORKER_INTERVAL_MS)
      │  claim: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING …
      │  expired → EXPIRED · no token → FAILED(NoToken) · send batch (Expo, 100/request)
      │  ok → SENT(ticket) · retryable error → PENDING, backoff 5 s·2ⁿ (cap 5 min, ±20 %)
      │  DeviceNotRegistered → token deleted, FAILED · other permanent → FAILED
      ▼
receipts (after PUSH_RECEIPT_DELAY_SECONDS, ~15 min): DELIVERED, or FAILED (+ dead token removed)
retention: rows deleted after PUSH_DELIVERY_RETENTION_DAYS (default 7)
```

- **Idempotent:** `(device_id, dedupe_key)` is unique (`message:<id>`, `call:<id>:incoming`,
  `community:<type>:<key>`, `contact:<id>:request`): a retried or duplicated event never
  notifies twice.
- **Crash-safe:** a claimed row is locked for 60 s; if its worker dies, another reclaims it.
  At-least-once delivery is possible after a crash mid-send (rare; harmless for an alert).
- **Bounded:** `PUSH_MAX_ATTEMPTS` (default 5) per push; each push has an expiry (calls 45 s,
  messages 1 day, others up to 7 days), also passed to the provider as `ttl`.
- **Why not BullMQ:** OGC already uses Redis for rate limits, presence and fan-out, but has no
  job-queue library. A PostgreSQL queue keeps one durable source of truth, needs no new
  dependency, and survives a Redis loss. It handles OGC's expected volume; a dedicated queue
  can replace it behind `PushDeliveryService` if throughput requires.

## Preferences

Account-wide, stored on the server (`notification_settings`), so all devices follow them:
master switch; direct messages; groups (messages, mentions, invitations); channels; contact
requests; calls; preview (`GENERIC` default, `SENDER`); sound; vibration; quiet hours (start,
end, IANA time zone; may wrap past midnight). During quiet hours pushes arrive **silently**
(no sound/vibration) rather than being dropped. Per-conversation level (`ALL` / `MENTIONS` /
`NONE`) and mute stay on the conversation. Validated by `notificationSettingsUpdateSchema`
(strict; real IANA zones only; no empty window); changes apply only to the signed-in account.

Android: sound/vibration are applied through notification channels the app creates
(`ogc-alerts`, `ogc-sound`, `ogc-vibrate`, `ogc-silent`, `ogc-calls`); people can further adjust
them in system settings.

## Devices and tokens

- `PUT /api/v1/notifications/push-token` binds the token to the **authenticated session's
  device** (never a client-supplied user or device); a token registered elsewhere moves (one
  installation, one owner). Rate-limited (`RATE_LIMIT_PUSH_REGISTER`).
- Logout or any session revocation deletes that device's token (with its encryption keys).
  Pushes only go to devices with a live session and an ACTIVE account.
- The app registers after sign-in (asking permission once), on token rotation, and from the
  settings screen; permission refusal leaves the app fully usable.
- The mobile app closes its realtime connection in the background (unless a call is active),
  so the server switches to pushes promptly instead of assuming the open app shows the event.

## Limits (not promises)

- Delivery depends on Apple/Google/Expo, the device's network, battery optimisation (Doze,
  OEM "app killers"), Focus/Do Not Disturb, and the person's permission. Pushes may be delayed,
  coalesced or dropped; OGC never relies on them for data.
- Calls do **not** ring while the app is closed: an "Incoming call" push is an ordinary
  notification. Ringing needs VoIP push (PushKit) + CallKit and ConnectionService — not built.
- iOS cannot change a push's sound per user without the app present; quiet hours are applied
  server-side by omitting the sound.
- No badge counts; no web push.
