# Planned development phases

Each phase ends with passing quality gates (format, lint, typecheck, tests, build, audit)
and an explicit review before the next begins. Scope may be re-ordered by the owner.

| Phase | Name                               | Scope                                                                                                                                                                                                                                                                                                          |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 ✓   | Foundation                         | Monorepo, tooling, quality gates, CI, Docker, API/web/mobile shells, design tokens, documentation                                                                                                                                                                                                              |
| 1 ✓   | Identity & authentication          | Random OGC IDs, users/credentials/profiles/devices/sessions schema and migrations, email registration and verification, Argon2id passwords, opaque rotating sessions (web cookies, mobile secure storage), deny-by-default auth guard, append-only audit log, web and mobile sign-in flows, OGC ID QR (web)    |
| 2 ✓   | Profiles & contacts                | Profiles with photo and bio, privacy settings, exact OGC ID discovery, contact requests and contacts, blocking, reporting with a staff-only queue, QR and link sharing, deep links (web and mobile)                                                                                                            |
| 3 ✓   | Private messaging, realtime & E2EE | One-to-one conversations between contacts, MLS end-to-end encryption between devices, realtime (Socket.IO), multi-device sync and offline outbox, receipts, typing, presence, replies, edits, deletes, forwards, reactions, encrypted images/files/voice, on-device search, push backend, Redis-backed scaling |
| **4** | **Groups & channels** (next)       | Group conversations on MLS, roles within groups, channels                                                                                                                                                                                                                                                      |
| 5     | Media & device continuity          | S3-compatible storage with direct encrypted uploads, video playback, encrypted history transfer to new devices, device list and "sign out everywhere", mobile push registration                                                                                                                                |
| 6     | Messaging privacy controls         | Read-receipt and presence settings, message requests from non-contacts, safety-number verification state and key-change warnings, encrypted backups                                                                                                                                                            |
| 7     | Notifications                      | Rich (decrypted on device) notifications, notification preferences                                                                                                                                                                                                                                             |
| 8     | Calls                              | WebRTC signalling over the realtime layer, STUN/TURN, voice and video calls                                                                                                                                                                                                                                    |
| 9     | Trust & safety                     | Reporting, moderation tooling, administration console                                                                                                                                                                                                                                                          |
| 10    | Hardening & launch readiness       | Load testing, horizontal scaling (Redis adapter, shared rate-limit store), observability, external security review                                                                                                                                                                                             |

Future (unscheduled): business accounts, digital services, external integrations,
optional phone-number linking.

Phase 3 production prerequisites (see [encryption.md](../architecture/encryption.md)):
an independent security review of `ts-mls` and of OGC's MLS integration, verification of
the mobile crypto path on physical devices, and a Redis deployment.

Carried over from Phase 2 for later phases: password change and account recovery, "sign out
everywhere" and device list, email provider, S3-compatible media storage, universal links on
an approved domain, QR scanning in the mobile app, moderation console (Phase 9).
