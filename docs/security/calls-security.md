# Calls: security and privacy

Applies to one-to-one voice and video calls ([architecture](../architecture/calls.md)).

## What protects call content

- **Media encryption: DTLS-SRTP (mandatory in WebRTC).** Audio and video are encrypted between
  the two devices with keys negotiated by DTLS directly between them. The OGC API never
  receives media. A TURN server, when used, relays encrypted packets it cannot decrypt.
- **What this is not:** calls are **not** protected by OGC's MLS end-to-end encryption, and
  OGC does **not** claim they are end-to-end encrypted in the same sense as messages. The DTLS
  certificate fingerprints that bind the media keys travel in the session descriptions
  through OGC's signaling server and are **not** verified against the participants' MLS
  identities or safety numbers. A malicious or compromised signaling server could therefore
  substitute fingerprints and intercept media (a man-in-the-middle). Closing that gap needs
  fingerprint verification bound to the participants' identity keys (or insertable-streams
  end-to-end encryption) — not implemented.
- No recording: neither the server nor the apps record calls.

## Authorization (every signaling event)

| Threat                                    | Control                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated signaling                 | Only on the authenticated realtime connection (same sessions as REST; ACTIVE accounts only); sockets close on expiry and revocation                      |
| Forged caller or callee                   | Identity (user and device) comes from the socket session only; payloads are strict (unknown fields rejected)                                             |
| Calling outside a direct conversation     | `call.start` requires being a participant of a DIRECT conversation (others: `not_found`, indistinguishable from a nonexistent ID)                        |
| Bypassing a block                         | Same rules as messages: refused if you blocked them; if they blocked you, the call never reaches them (you see no answer) and it is not in their history |
| Calling inactive accounts                 | Refused (`unavailable`)                                                                                                                                  |
| Joining someone else's call               | Non-participants get `not_found` for every event; signaling is accepted only from the two bound devices                                                  |
| Duplicate acceptance / duplicate sessions | Conditional state updates (one winner); one open call per account enforced with advisory locks                                                           |
| Accepting expired, ended or stale calls   | Every event re-reads the call; ended calls refuse everything (`ended`); timeouts end abandoned calls                                                     |
| Replayed signaling                        | Bound to a random call ID and the call's state and devices; nothing is accepted after the call ends                                                      |
| Signaling spam                            | Per-account limits: `RATE_LIMIT_CALL_START` (10/min), `RATE_LIMIT_CALL_SIGNAL` (600/min); 16 KiB payload cap; SDP ≤ 12 000 chars, candidates ≤ 1 KiB     |
| Blocking someone during a call            | The call ends at once, reported to the other person as an ordinary hang-up (the block is not revealed)                                                   |

## Network addresses (IP privacy)

WebRTC exchanges ICE candidates, which contain IP addresses. In a direct (peer-to-peer) call
each participant can learn the other's public IP address (and, on the same network, the local
address). OGC limits this:

- Addresses are only exchanged **after** the callee accepts: an unanswered call, a declined
  call or a call to someone who blocked you reveals nothing.
- `WEBRTC_ICE_TRANSPORT_POLICY=relay` forces all media through TURN, so neither participant
  learns the other's address (the TURN operator sees both). Requires a TURN server.
- STUN servers learn the public address of each device that uses them. With no STUN configured
  (the default), only devices on the same network can connect directly.

## TURN

- Credentials are **short-lived and per call**: TURN REST API scheme (`username =
<expiry>:<call ID>`, `credential = HMAC-SHA1(secret, username)`), valid for
  `WEBRTC_TURN_CREDENTIAL_TTL_SECONDS` (default 1 h). The shared secret
  (`WEBRTC_TURN_SECRET`) stays in the API and the TURN server; it is never sent to clients,
  logged or placed in a client bundle. No user identifier appears in TURN logs (the label is the
  call ID).
- The TURN operator can see who connects (IP addresses), when, and how much traffic flows —
  not the content. Run it yourself or choose a provider whose logging policy you accept.
  Prefer `turns:` (TLS, port 5349 or 443) so restrictive networks and observers see only TLS.
- Restrict the TURN server: deny relaying to private and loopback ranges
  (`denied-peer-ip`), set quotas, and keep the secret out of version control.

## Logging and diagnostics

Signaling payloads (SDP, ICE candidates) are never logged; failures log only the error class
and a reason code. Metrics carry low-cardinality labels only (media type, outcome, reason) —
never user, call or conversation IDs. Call history stores metadata only (participants, type,
outcome, timestamps); retention `CALL_HISTORY_RETENTION_DAYS`.

## Push

Call pushes contain fixed texts ("Incoming call", "Missed call") and the call/conversation
IDs — never the caller's name, OGC ID or the call type. Push services learn only that a call
event happened.

## Transport

Production requires HTTPS for the API and web app, so signaling runs over `wss://`. Browsers
allow camera and microphone only in secure contexts (HTTPS, or `localhost` in development).
Release mobile builds use HTTPS only (ATS / no cleartext).

## Residual risks and follow-up

1. Media keys are not bound to MLS identities (signaling-server MITM possible) — see above.
2. Peer-to-peer calls reveal IP addresses to the other participant unless relay-only is set.
3. `react-native-webrtc` 124.x is reported as "untested on the New Architecture" by React
   Native Directory; React Native 0.86 runs only the New Architecture. Verify on physical
   devices before release (see the development guide).
4. No independent security review of the calling implementation yet.
