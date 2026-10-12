# Security principles and controls

Security is a first-class architectural requirement. OGC does not claim to be "100%
secure"; instead it maintains **specific controls**, each with a way to **verify** it.
This document lists what exists today and what each later phase must add.

## Principles

1. **Least privilege** — processes, database roles, containers, CI tokens, and users get
   only the access they need.
2. **Secure by default** — insecure configuration fails at startup rather than running.
3. **Validate at every boundary** — environment, HTTP input, WebSocket messages, files,
   and third-party responses are parsed with schemas before use.
4. **No secrets in source** — configuration via environment; only `.env.example` files
   with placeholders are committed.
5. **Fail closed, leak nothing** — errors reaching clients never contain stack traces,
   SQL, or internal messages.
6. **Defence in depth** — header policies, rate limits, authorization in guards _and_
   services, network isolation.
7. **Observable** — structured logs with request correlation; security events go to an
   append-only audit log (Phase 1+).
8. **Verified continuously** — controls have automated tests or CI checks where possible.

## Controls in place (Phase 0)

| Control                                     | Implementation                                                                                                                         | Verification                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Configuration validation, fail-fast         | `apps/api/src/config/env.schema.ts` (Zod); invalid config aborts startup                                                               | `env.schema.test.ts`                                   |
| Secrets never echoed in config errors       | Error lists variable names and problems only                                                                                           | `env.schema.test.ts`                                   |
| Production requires HTTPS CORS origins      | `superRefine` in env schema                                                                                                            | `env.schema.test.ts`                                   |
| CORS allowlist (exact origins, no wildcard) | `configure-app.ts`                                                                                                                     | e2e: allowed vs denied origin                          |
| Secure HTTP headers (CSP, HSTS, nosniff, …) | Helmet in API; nginx `security-headers.conf` for web                                                                                   | e2e header assertions; manual `curl -I`                |
| Framework fingerprint hidden                | `x-powered-by` disabled; nginx `server_tokens off`                                                                                     | e2e                                                    |
| Request body size limit (100 kB)            | Body parser limits; nginx `client_max_body_size`                                                                                       | e2e: 413 on oversized body                             |
| Malformed input rejected cleanly            | Body-parser errors mapped to structured 4xx                                                                                            | e2e: 400 on malformed JSON                             |
| Safe error handling                         | Global `HttpExceptionFilter`; 5xx → generic message, details logged server-side                                                        | e2e: no leak of internal message                       |
| Rate limiting                               | Global `ThrottlerGuard` (env-configurable)                                                                                             | Configured; per-route tests arrive with auth endpoints |
| Request correlation                         | `X-Request-Id` (validated if supplied, else UUID)                                                                                      | e2e                                                    |
| Log redaction                               | Pino redaction of auth headers, cookies, token/password fields; no bodies or query strings logged                                      | Manual check of container logs (Phase 0 run)           |
| Strict TypeScript + type-aware lint         | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; `typescript-eslint` strict-type-checked; `no-eval`, `no-new-func`  | CI                                                     |
| Dependency audit                            | `pnpm audit --audit-level=high`                                                                                                        | CI `security` job                                      |
| Supply-chain hardening                      | Install scripts denied unless allow-listed; minimum release age for new versions; frozen lockfile in CI; Actions pinned to commit SHAs | pnpm policy; CI                                        |
| Container hardening                         | Non-root users, read-only root FS, `no-new-privileges`, all capabilities dropped, ports bound to 127.0.0.1 locally                     | `docker-compose.yml` review                            |
| No public source maps                       | Removed from the web image at build time                                                                                               | Verified 404 in Phase 0 run                            |
| Accessible, legible UI                      | Token colour pairs tested against WCAG 2.2 AA                                                                                          | `packages/ui/src/tokens.test.ts`                       |
| Mobile data backup disabled                 | `android.allowBackup: false`                                                                                                           | `app.json` review                                      |

## Required in later phases

| Phase | Control                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Password hashing with **Argon2id** (tuned parameters), breached-password check, credential stuffing protection (per-account and per-IP limits) |
| 1     | Short-lived access tokens + rotating refresh tokens bound to a device session; server-side session revocation                                  |
| 1     | Cookie-based web sessions are `HttpOnly`, `Secure`, `SameSite`; **CSRF protection** for any cookie-authenticated state-changing request        |
| 1     | RBAC: deny-by-default guards plus ownership checks in services; authorization tests per endpoint                                               |
| 1     | Append-only audit log for security events (logins, credential changes, role changes, admin actions)                                            |
| 1     | Least-privilege database roles: migration role ≠ runtime role; TLS to the database                                                             |
| 1     | Shared rate-limit store (Redis) when more than one API instance runs                                                                           |
| 3     | WebSocket authentication at connect time, per-message validation and authorization, connection/message rate limits                             |
| 6     | Upload validation (type sniffing, size limits), malware scanning, private object storage with short-lived signed URLs                          |
| 8     | Short-lived TURN credentials; signalling authorization per call                                                                                |
| 9     | Moderation actions audited; admin console behind separate role and MFA                                                                         |
| 10    | External penetration test, threat model review, incident response runbook                                                                      |

Under consideration: end-to-end encryption for message content (affects search, moderation,
and multi-device design — needs a decision before Phase 3).

## Reporting a vulnerability

Report suspected vulnerabilities privately to ObagaGlobal Ltd (a dedicated security contact
will be published before launch). Do not open public issues for security problems.
