# Planned development phases

Each phase ends with passing quality gates (format, lint, typecheck, tests, build, audit)
and an explicit review before the next begins. Scope may be re-ordered by the owner.

| Phase | Name                               | Scope                                                                                                                                                                                                                                                                                                                 |
| ----- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 ✓   | Foundation                         | Monorepo, tooling, quality gates, CI, Docker, API/web/mobile shells, design tokens, documentation                                                                                                                                                                                                                     |
| 1 ✓   | Identity & authentication          | Random OGC IDs, users/credentials/profiles/devices/sessions schema and migrations, email registration and verification, Argon2id passwords, opaque rotating sessions (web cookies, mobile secure storage), deny-by-default auth guard, append-only audit log, web and mobile sign-in flows, OGC ID QR (web)           |
| 2 ✓   | Profiles & contacts                | Profiles with photo and bio, privacy settings, exact OGC ID discovery, contact requests and contacts, blocking, reporting with a staff-only queue, QR and link sharing, deep links (web and mobile)                                                                                                                   |
| 3 ✓   | Private messaging, realtime & E2EE | One-to-one conversations between contacts, MLS end-to-end encryption between devices, realtime (Socket.IO), multi-device sync and offline outbox, receipts, typing, presence, replies, edits, deletes, forwards, reactions, encrypted images/files/voice, on-device search, push backend, Redis-backed scaling        |
| 4 ✓   | Groups & channels                  | Private groups and private encrypted channels on MLS (≤ 32 members, roles, invitations, links/QR, removal with cryptographic cut-off, archive/delete), server-readable community channels (discovery, join policies, posts/replies/announcements/pins, moderation, reports), in-app notifications with generic push   |
| 5     | Media & device continuity          | S3-compatible storage with direct encrypted uploads, video playback, encrypted history transfer to new devices, device list and "sign out everywhere", mobile push registration                                                                                                                                       |
| 6     | Messaging privacy controls         | Read-receipt and presence settings, message requests from non-contacts, safety-number verification state and key-change warnings, encrypted backups                                                                                                                                                                   |
| 7 ✓   | Notifications                      | Mobile push (Expo → FCM/APNs) with a durable retrying queue, account notification settings (categories, private/sender previews, sound, vibration, quiet hours), tap routing, web settings page. Not yet: web push, rich previews decrypted on device, badges                                                         |
| 8 ✓   | Calls (delivered early)            | One-to-one voice and video calls in direct conversations (web, mobile development/release builds): WebRTC media, signaling over the realtime layer, configurable STUN/TURN, call history, generic call push. Not yet: group calls, CallKit/ConnectionService ringing while closed, VoIP push, media keys bound to MLS |
| 9     | Trust & safety                     | Reporting, moderation tooling, administration console                                                                                                                                                                                                                                                                 |
| 10    | Hardening & launch readiness       | Load testing, horizontal scaling (Redis adapter, shared rate-limit store), observability, external security review                                                                                                                                                                                                    |

Future (unscheduled): business accounts, digital services, external integrations,
optional phone-number linking.

Phase 4 production prerequisites: the same independent MLS review (now covering group
membership changes), load tests of commit sizes at the 128-leaf cap on mid-range phones, and an
approved public web domain for invitation links (`EXPO_PUBLIC_WEB_APP_URL`).

Phase 3 production prerequisites (see [encryption.md](../architecture/encryption.md)):
an independent security review of `ts-mls` and of OGC's MLS integration, verification of
the mobile crypto path on physical devices, and a Redis deployment.

Security and privacy hardening (2026-10-15, [security-review.md](../security/security-review.md)):
device list, sign-out of other devices and password change, key-change warnings and a
persisted verified state for direct conversations, and production camera/microphone headers.
Still open: account recovery, retention jobs, independent cryptographic review, penetration
test and physical-device testing.

Account recovery and production readiness (2026-10-15): password reset by email (SMTP provider),
retention cleanup with preservation holds, immediate suspension, encrypted backup/restore
scripts, and a production-readiness audit ([production-readiness.md](../operations/production-readiness.md)).
Still open: second factor, history recovery (needs its own design), account deletion/export.

Carried over from Phase 2 for later phases: email provider, S3-compatible media storage, universal links on
an approved domain, QR scanning in the mobile app, moderation console (Phase 9).
