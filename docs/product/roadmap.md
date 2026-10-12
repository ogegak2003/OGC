# Planned development phases

Each phase ends with passing quality gates (format, lint, typecheck, tests, build, audit)
and an explicit review before the next begins. Scope may be re-ordered by the owner.

| Phase | Name                            | Scope                                                                                                                                                                      |
| ----- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **Foundation** (current)        | Monorepo, tooling, quality gates, CI, Docker, API/web/mobile shells, design tokens, documentation                                                                          |
| 1     | Identity & authentication       | First Prisma models and migrations, OGC identity issuance, registration/login, password hashing (Argon2id), sessions & refresh tokens, RBAC skeleton, audit log foundation |
| 2     | Profiles & contacts             | Profiles, QR identity sharing, contact discovery by OGC identity, blocking, privacy settings                                                                               |
| 3     | Realtime & one-to-one messaging | Socket.IO gateway with authenticated connections, conversations, messages, delivery/read receipts, typing, presence                                                        |
| 4     | Rich messaging                  | Replies, editing, deletion, forwarding, reactions, search                                                                                                                  |
| 5     | Groups & channels               | Group conversations, roles within groups, channels                                                                                                                         |
| 6     | Media                           | Object storage, uploads with scanning, images, files, voice messages                                                                                                       |
| 7     | Devices & notifications         | Multi-device sessions, session management UI, push notifications                                                                                                           |
| 8     | Calls                           | WebRTC signalling over the realtime layer, STUN/TURN, voice and video calls                                                                                                |
| 9     | Trust & safety                  | Reporting, moderation tooling, administration console                                                                                                                      |
| 10    | Hardening & launch readiness    | Load testing, horizontal scaling (Redis adapter, shared rate-limit store), observability, external security review                                                         |

Future (unscheduled): business accounts, digital services, external integrations,
optional phone-number linking.
