# One-to-one voice and video calls

Decision: [ADR-037](decisions.md#adr-037-one-to-one-calls-webrtc-media-realtime-signaling).
Status: **Implemented** for one-to-one calls in direct conversations, on the web and in the
native mobile app (development and release builds). **Not available in Expo Go** (no native
WebRTC). Group calls, screen sharing, call recording and operating-system call integration
(CallKit / ConnectionService) are **not implemented**.

Security and privacy: [calls-security.md](../security/calls-security.md). Setup, STUN/TURN,
testing on two devices and troubleshooting: [development/calls.md](../development/calls.md).

## Overview

```
 Caller device                    OGC API (signaling)                  Callee devices
 ─────────────                    ───────────────────                  ──────────────
 call.start ───────────────────▶  authorize, create call (RINGING) ──▶ call.incoming (all)
                                                                       call.accept (one)
 call.accepted ◀─────────────────  ACCEPTED, bind callee device ◀──────┘
                                  call.answered_elsewhere ───────────▶ (other devices stop)
 offer (SDP) ──── call.signal ───▶  relay to the bound device only ───▶ answer (SDP)
 ICE candidates ◀──────────────── call.signal ─────────────────────▶ ICE candidates
 call.connected ─────────────────▶  connectedAt (duration starts)
          ◀═══════════════ media: WebRTC, DTLS-SRTP, peer-to-peer or via TURN ═══════════▶
 call.end ───────────────────────▶  ENDED + outcome ─────────────────▶ call.ended (both)
```

- **Signaling** uses the existing authenticated Socket.IO connection (namespace `/v1`, see
  [realtime.md](realtime.md)). Every call event is in the closed event contract, validated
  with Zod (`@ogc/validation` `calls.ts`), rate-limited per account and authorized against the
  stored call and the sender's session (user **and** device). Identity never comes from
  payloads; extra fields are rejected.
- **Media** is WebRTC: browsers' built-in implementation on the web, `react-native-webrtc`
  124.0.8 in the mobile app. Audio and video are encrypted with DTLS-SRTP between the two
  devices; the API never sees media.
- **One engine for both apps:** `CallEngine` in `@ogc/messaging` (`src/calls/`) drives the
  state machine, peer connection, ICE and recovery through a small platform interface
  (`CallMediaPlatform`): `browser-call-media.ts` on the web, `native-call-media.ts` on mobile.

## Call state (server)

Stored in PostgreSQL (`calls`, [data-model.md](data-model.md#calls)) — the source of truth,
shared by every API instance. Transitions are conditional `UPDATE … WHERE status = <expected>`,
so concurrent events have exactly one winner (two devices accepting, a hang-up racing a
timeout).

| From       | Event                                    | To / outcome                                                                                   |
| ---------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| —          | `call.start` (callee free)               | `RINGING`                                                                                      |
| —          | `call.start` (callee in a call)          | `ENDED` / `BUSY` (the callee is not rung)                                                      |
| `RINGING`  | `call.accept` (callee, any device)       | `ACCEPTED`; that device is bound to the call                                                   |
| `RINGING`  | `call.decline` / callee hang-up          | `ENDED` / `DECLINED`                                                                           |
| `RINGING`  | `call.cancel` (caller's device)          | `ENDED` / `CANCELLED`                                                                          |
| `RINGING`  | ring timeout (45 s)                      | `ENDED` / `MISSED`                                                                             |
| `RINGING`  | caller's device offline > grace (20 s)   | `ENDED` / `CANCELLED`                                                                          |
| `ACCEPTED` | `call.connected` (first report)          | `ACCEPTED`, `connectedAt` set                                                                  |
| `ACCEPTED` | `call.end` (a bound device)              | `ENDED` / `COMPLETED` if connected, else `CANCELLED` (`FAILED` if reported as a media failure) |
| `ACCEPTED` | never connected within 30 s              | `ENDED` / `FAILED`                                                                             |
| `ACCEPTED` | a bound device offline > grace (20 s)    | `ENDED` / `COMPLETED` if connected, else `FAILED`                                              |
| any open   | block between the two (either direction) | `ENDED`, reported as an ordinary hang-up                                                       |
| any open   | open longer than 4 h                     | `ENDED`                                                                                        |
| `ENDED`    | anything                                 | refused (`ended`) — stale and replayed events                                                  |

Rules (pure functions in `apps/api/src/modules/calls/call-rules.ts`, unit-tested):

- Only the **caller's device** offers (initial offer and ICE restarts); only the **callee's
  bound device** answers. A fixed direction means offers never collide ("glare").
- Signaling (`offer`, `answer`, `ice`, `media`) is relayed only between the two bound devices,
  only while `ACCEPTED`. The caller's other devices, the callee's other devices and anyone else
  are refused.
- The caller sends its offer **after** the answer: before that, neither side learns the other's
  network addresses (see the security document).
- One open call per account: `call.start` takes PostgreSQL advisory locks on both accounts
  (fixed order) inside a transaction, then checks for open calls — no duplicate sessions, and
  two people calling each other at the same moment get one call and one `BUSY`.
- Timeouts run in a sweeper on every instance (`CALL_SWEEP_INTERVAL_MS`, default 5 s); device
  liveness comes from the shared presence store (Redis in production).

## Client engine

`CallEngine` phases: `idle → outgoing | incoming → connecting → active → ended`.

- **Permissions at the right time.** The microphone (and camera, for video only) is requested
  when the person starts or answers a call — never for a voice call's camera, never in
  advance. A refusal ends the attempt with a clear message; an incoming call is declined so
  the caller is not left waiting.
- **Honest status.** Outgoing calls say "Calling…" (the server cannot know whether the other
  phone rings). The duration starts when ICE actually connects, from the local clock; the
  server records its own `connectedAt` for history.
- **Recovery.** If media drops (`disconnected`/`failed`), the caller restarts ICE (after 4 s,
  or at once on `failed`); the call ends as failed if it has not recovered within 20 s.
  Network changes on mobile surface the same way.
- **Reconnection and background.** After the realtime connection returns, and when the app or
  tab comes back to the foreground, the engine asks `call.sync`: it closes a call that ended
  meanwhile and shows a call that started ringing meanwhile. A call that was active on a
  device whose page was reloaded is ended (its media session is gone).
- Mute and camera-off disable the track (no renegotiation) and tell the other side
  (`media` signal) so it can show "muted" / "camera off" instead of silence or a black frame.
- Camera switching: front/rear on phones (`applyConstraints({ facingMode })`); cycling through
  cameras by device ID on computers (`replaceTrack`).

## Call history

`GET /api/v1/calls?conversationId=&cursor=&limit=` returns the viewer's calls (metadata only),
newest first. Conversation history requires being a participant (404 otherwise, as for
messages). The apps merge these rows into the conversation timeline ("Missed video call",
"Outgoing voice call · 2:31"). A call is hidden from a callee who had blocked the caller.
Ended calls are deleted after `CALL_HISTORY_RETENTION_DAYS` (default 365). No audio, video,
session descriptions or network addresses are stored.

## Incoming calls and push

While an app is open (foreground, connected), incoming calls arrive in real time on every
signed-in device of the callee. Devices without a live connection that registered a push token
get a generic push — "Incoming call", later "Missed call" if unanswered — never the caller's
name or the call type, and not when the conversation is muted.

**Limits (not implemented):**

- A push notification is an ordinary notification: it does **not** ring like a phone call,
  and calls do **not** ring while the app is terminated. That needs VoIP push (Apple PushKit,
  Firebase high-priority data messages) plus CallKit (iOS) / `ConnectionService` (Android) —
  native integration, an Apple Developer membership and push credentials.
- The mobile app does not yet register push tokens (planned with mobile push registration),
  so call pushes currently reach no phone even with `PUSH_PROVIDER=expo`.
- **Background:** on Android, without a foreground service, the system may cut microphone
  access shortly after the app leaves the screen; on iOS, without the `audio`/`voip` background
  modes, the app is suspended. Keep the app open during calls. Returning to the app restores
  the call screen (or shows that the call ended).
- **Audio routing:** Android starts voice calls on the earpiece and video calls on the
  speaker, with a speaker toggle. iOS uses WebRTC's own audio session (no speaker toggle yet).
  Bluetooth headsets follow the operating system's routing; there is no in-app picker.

## Scaling

- **Signaling state** is in PostgreSQL; transitions are atomic, so any instance can handle
  any event. Socket.IO events reach the right devices on every instance through the Redis
  adapter (rooms `user:<id>`, `device:<id>`).
- **Sweeper:** each instance scans open calls (`status, created_at` index, ≤ 1000 per pass)
  and checks device liveness with one presence query per pass. Conditional updates make
  concurrent sweeps harmless; the instance whose update wins announces the end.
- **Media does not touch the API.** With TURN, relayed media goes through the TURN servers —
  plan their bandwidth (roughly 2 × call bitrate per relayed call: ~100 kbit/s voice,
  1–2.5 Mbit/s video).
- Metrics: `ogc_calls_started_total{media}`, `ogc_calls_ended_total{media,outcome}`,
  `ogc_calls_open`, `ogc_messaging_failures_total{operation="call",reason}`,
  `ogc_rate_limited_total{scope="realtime_callStart|realtime_callSignal"}`.
