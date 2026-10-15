# Calls: setup, testing and operations

Architecture: [calls.md](../architecture/calls.md). Security and privacy:
[calls-security.md](../security/calls-security.md).

## Requirements at a glance

| Where                    | Calls work when…                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Web                      | The page is served over **HTTPS**, or from `http://localhost` (browsers block camera/microphone on other HTTP origins) |
| Mobile development build | Built with `react-native-webrtc` (`pnpm --filter @ogc/mobile android:build debug`, or an EAS `development` build)      |
| **Expo Go**              | **Never** — Expo Go cannot load WebRTC's native code. The app says so instead of failing; messaging still works there  |
| Two devices, one network | Works with no STUN/TURN configured (host candidates)                                                                   |
| Different networks       | Needs STUN, and TURN for symmetric NATs, carrier-grade NAT and restrictive firewalls (often mobile data, offices)      |

## Configuration (API)

All optional; with nothing set, calls work between devices on the same network and no
external provider is contacted. Placeholders only — never commit real secrets.

| Variable                             | Default | Description                                                                                              |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `WEBRTC_STUN_URLS`                   | _empty_ | Comma-separated `stun:`/`stuns:` URLs                                                                    |
| `WEBRTC_TURN_URLS`                   | _empty_ | Comma-separated `turn:`/`turns:` URLs (TURN REST API / coturn `use-auth-secret`)                         |
| `WEBRTC_TURN_SECRET`                 | _unset_ | Shared secret with the TURN server (≥ 32 chars; required with `WEBRTC_TURN_URLS`). Never sent to clients |
| `WEBRTC_TURN_CREDENTIAL_TTL_SECONDS` | `3600`  | Lifetime of per-call TURN credentials (300–86400)                                                        |
| `WEBRTC_ICE_TRANSPORT_POLICY`        | `all`   | `relay` sends all media through TURN (hides participants' IPs from each other; needs TURN)               |
| `CALL_RING_TIMEOUT_SECONDS`          | `45`    | Unanswered calls end as missed                                                                           |
| `CALL_CONNECT_TIMEOUT_SECONDS`       | `30`    | Answered calls whose media never connects end as failed                                                  |
| `CALL_RECONNECT_GRACE_SECONDS`       | `20`    | How long a device in a call may lose its realtime connection                                             |
| `CALL_MAX_DURATION_MINUTES`          | `240`   | Safety net for abandoned calls                                                                           |
| `CALL_SWEEP_INTERVAL_MS`             | `5000`  | How often each instance checks open calls                                                                |
| `CALL_HISTORY_RETENTION_DAYS`        | `365`   | Ended calls (metadata) are deleted after this                                                            |
| `RATE_LIMIT_CALL_START`              | `10`    | Calls started per minute per account                                                                     |
| `RATE_LIMIT_CALL_SIGNAL`             | `600`   | Signaling events per minute per account                                                                  |

Example (`apps/api/.env`, placeholders):

```dotenv
WEBRTC_STUN_URLS=stun:turn.example.org:3478
WEBRTC_TURN_URLS=turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349?transport=tcp
WEBRTC_TURN_SECRET=replace-with-a-long-random-secret-from-your-secret-store
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
and store it in your secret manager; set the same value as coturn's `static-auth-secret`.

## TURN server (coturn)

An example configuration with placeholders is in
[`infrastructure/turn/turnserver.conf.example`](../../infrastructure/turn/turnserver.conf.example).
Key points:

- `use-auth-secret` + `static-auth-secret=<WEBRTC_TURN_SECRET>` (TURN REST API).
- A public IP and DNS name; a TLS certificate for `turns:` (5349, or 443 to pass strict
  firewalls).
- Open **3478/udp+tcp**, **5349/tcp** (TLS) and the relay range (e.g. **49152–65535/udp**).
- `denied-peer-ip` for private, loopback and link-local ranges, so the relay cannot reach
  internal networks; `no-cli`, `fingerprint`, quotas (`user-quota`, `total-quota`).
- Bandwidth: a relayed video call uses roughly 2 × 1–2.5 Mbit/s on the TURN server.

The local Docker stack does not run TURN (relays need many public UDP ports, which Docker
Desktop on Windows/macOS handles poorly). Test TURN on a host with a public IP.

## Firewall and NAT

- Same Wi-Fi: devices connect directly (host candidates) — make sure the network has no
  client isolation (guest networks often do).
- Different networks: STUN lets most home NATs connect directly; symmetric NAT, CGNAT
  (common on mobile data) and corporate firewalls need TURN. Without TURN those calls end as
  "Call couldn't connect" after 30 s — the app never shows a fake connection.
- The API needs only its usual HTTPS port; WebRTC media never goes through it.
- Windows development machine: the API (3000) and Metro (8081) must be reachable from the
  phone ([mobile.md](mobile.md#endpoints-api-realtime-invitation-links)); media flows directly
  between the two phones, not through the PC.

## HTTPS and WebSocket in production

- The API, the web app and the realtime endpoint must be HTTPS / `wss://` (enforced by the
  existing production configuration checks; browsers also require HTTPS for camera access).
- Behind a load balancer: WebSocket upgrades on `/api/realtime`; Redis (`REDIS_URL`) so
  signaling reaches devices on any instance.

## Mobile permissions

| Platform | Permission                     | When asked                         | Text                                                                       |
| -------- | ------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| Android  | `RECORD_AUDIO`                 | Starting or answering any call     | "OGC uses your microphone during calls you make or answer."                |
| Android  | `CAMERA`                       | Starting or answering a video call | "OGC uses your camera only during video calls you make or answer."         |
| iOS      | `NSMicrophoneUsageDescription` | First microphone use               | "OGC uses your microphone for voice messages you record and during calls." |
| iOS      | `NSCameraUsageDescription`     | First video call                   | "OGC uses your camera only during video calls you make or answer."         |

The camera is never requested for voice calls. If a permission is refused, the call screen
explains it; to change it later use the system settings (Settings → Apps → OGC → Permissions on
Android; Settings → OGC on iOS). Added Android permissions (from the WebRTC config plugin):
`CAMERA`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `BLUETOOTH`; `SYSTEM_ALERT_WINDOW` stays blocked.

## Testing a call on two devices

Automated tests use **simulated** media (fake devices and peer connections) — they verify the
call logic, not real audio/video. Real calls must be checked by hand:

**Web ↔ web (simplest).** Start the API and web app (`pnpm --filter @ogc/api dev`,
`pnpm --filter @ogc/web dev`). Open `http://localhost:5173` in two browser profiles (or two
browsers), sign in as two accounts that are contacts, open their conversation, press the
phone (voice) or camera (video) icon in the header; accept in the other window. Check: both
hear each other, mute/camera/switch work, the timer starts only when connected, ending shows
the outcome in both timelines. (A second computer on the LAN needs HTTPS for the web app.)

**Phone ↔ phone or phone ↔ web.**

1. Build and install the development build (not Expo Go) on each phone:
   `$env:OGC_ANDROID_ABIS = "arm64-v8a"; pnpm --filter @ogc/mobile android:build debug`, then
   `adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` — or an EAS
   `development` build. iOS needs a Mac or EAS (see [mobile.md](mobile.md)).
2. Start Metro (`pnpm --filter @ogc/mobile dev`, with `REACT_NATIVE_PACKAGER_HOSTNAME` set to
   the PC's Wi-Fi IPv4) and the API; open the development build and connect to Metro.
3. Sign in as two contacts (one per device), open the conversation, call, accept.
4. Try: voice and video, mute, camera off, flip camera, speaker (Android), decline, cancel
   before answer, no answer (45 s), hang-up from each side, Wi-Fi off during a call
   (reconnecting → recovery or "Connection lost"), app to background and back.

## Compatibility

- Browsers: current Chrome, Edge, Firefox and Safari (desktop and mobile). Safari on iOS
  needs HTTPS and a user tap before audio plays; camera switching uses `facingMode` there.
- Mobile: Android 7+ / iOS 15.1+ via `react-native-webrtc` 124.0.8 in development and release
  builds; New Architecture compatibility is not certified upstream (React Native Directory:
  "untested on New Architecture") — verify on devices before release.
- Expo Go: no calls.
- Screen sharing, group calls, picture-in-picture, call waiting, CallKit/ConnectionService and
  ringing while the app is closed are not implemented.

## Monitoring and troubleshooting

Metrics (`GET /api/v1/metrics`): `ogc_calls_started_total`, `ogc_calls_ended_total{outcome}`,
`ogc_calls_open`, `ogc_messaging_failures_total{operation="call"}` and
`ogc_rate_limited_total{scope=~"realtime_call.*"}`. A high share of `FAILED` outcomes usually
means missing or unreachable TURN.

| Symptom                                              | Likely cause / fix                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Call buttons disabled on the web ("needs HTTPS")     | The page is on plain HTTP other than localhost — serve it over HTTPS                               |
| "Calls aren't available in Expo Go"                  | Install the development build                                                                      |
| Stuck on "Connecting…", then "Call couldn't connect" | No network path: different networks without TURN, client isolation on Wi-Fi, firewall blocking UDP |
| "OGC needs your microphone…"                         | Permission refused — enable it in system/browser settings                                          |
| Calls drop after a few seconds in the background     | Platform background limits (see the architecture document) — keep the app open                     |
| Video plays through the earpiece (Android)           | Tap Speaker; video calls start on the speaker                                                      |
| `rate_limited`                                       | More than `RATE_LIMIT_CALL_START` calls per minute                                                 |

In the browser, `chrome://webrtc-internals` (or `about:webrtc` in Firefox) shows ICE candidate
pairs and why a connection failed. Server logs never contain session descriptions or
candidates; they log only reason codes.
