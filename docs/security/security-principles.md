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

## Controls in place

Phase 1 authentication controls are detailed in [authentication.md](authentication.md);
Phase 2 social and media controls in [social-safety.md](social-safety.md); Phase 3
messaging, realtime and encryption controls in [messaging-security.md](messaging-security.md).

| Control                                     | Implementation                                                                                                                           | Verification                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Configuration validation, fail-fast         | `apps/api/src/config/env.schema.ts` (Zod); invalid config aborts startup                                                                 | `env.schema.test.ts`                                     |
| Secrets never echoed in config errors       | Error lists variable names and problems only                                                                                             | `env.schema.test.ts`                                     |
| Production requires HTTPS CORS origins      | `superRefine` in env schema                                                                                                              | `env.schema.test.ts`                                     |
| CORS allowlist (exact origins, no wildcard) | `configure-app.ts`                                                                                                                       | e2e: allowed vs denied origin                            |
| Secure HTTP headers (CSP, HSTS, nosniff, …) | Helmet in API; nginx `security-headers.conf` for web                                                                                     | e2e header assertions; manual `curl -I`                  |
| Framework fingerprint hidden                | `x-powered-by` disabled; nginx `server_tokens off`                                                                                       | e2e                                                      |
| Request body size limit (100 kB)            | Body parser limits; nginx `client_max_body_size`                                                                                         | e2e: 413 on oversized body                               |
| Malformed input rejected cleanly            | Body-parser errors mapped to structured 4xx                                                                                              | e2e: 400 on malformed JSON                               |
| Safe error handling                         | Global `HttpExceptionFilter`; 5xx → generic message, details logged server-side                                                          | e2e: no leak of internal message                         |
| Rate limiting                               | Global `ThrottlerGuard`; stricter per-route limits on auth endpoints                                                                     | Integration tests: `429 RATE_LIMITED`                    |
| Request correlation                         | `X-Request-Id` (validated if supplied, else UUID)                                                                                        | e2e                                                      |
| Log redaction                               | Pino redaction of auth headers, cookies, token/password/hash fields; no bodies or query strings logged                                   | Integration test scans trace-level logs for secrets      |
| Strict TypeScript + type-aware lint         | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; `typescript-eslint` strict-type-checked; `no-eval`, `no-new-func`    | CI                                                       |
| Dependency audit                            | `pnpm audit --audit-level=high`                                                                                                          | CI `security` job                                        |
| Supply-chain hardening                      | Install scripts denied unless allow-listed; minimum release age for new versions; frozen lockfile in CI; Actions pinned to commit SHAs   | pnpm policy; CI                                          |
| Container hardening                         | Non-root users, read-only root FS, `no-new-privileges`, all capabilities dropped, ports bound to 127.0.0.1 locally                       | `docker-compose.yml` review                              |
| No public source maps                       | Removed from the web image at build time                                                                                                 | Verified 404 in Phase 0 run                              |
| Accessible, legible UI                      | Token colour pairs tested against WCAG 2.2 AA                                                                                            | `packages/ui/src/tokens.test.ts`                         |
| Mobile data backup disabled                 | `android.allowBackup: false`                                                                                                             | `app.json` review                                        |
| Password hashing                            | Argon2id (OWASP parameters), NIST-style policy, transparent rehash                                                                       | Unit + integration tests                                 |
| Sessions                                    | Opaque hashed tokens; 15-min access; rotating refresh with reuse detection; immediate revocation                                         | Integration tests                                        |
| Browser credential protection               | HttpOnly, SameSite=Strict, `__Host-`/`__Secure-` cookies; tokens never exposed to JavaScript                                             | Integration tests                                        |
| CSRF                                        | SameSite=Strict plus required `X-OGC-Client` header on cookie-authenticated mutations                                                    | Integration test: `403 CSRF_REJECTED`                    |
| Deny-by-default authentication              | Global `AuthGuard`; `@Public()` opt-out; ACTIVE status required unless opted in; identity only from `AuthContext`                        | Integration tests                                        |
| Account enumeration resistance              | Identical register responses; generic login errors; dummy-hash timing parity                                                             | Integration tests                                        |
| Failed-login protection                     | Per-account lockout (10 failures → 15 min) plus per-IP login limits                                                                      | Integration test                                         |
| Append-only audit log                       | `audit_events` with a database trigger rejecting UPDATE/DELETE                                                                           | Database integration test                                |
| Database integrity                          | Unique indexes, FKs, CHECK constraints, immutable OGC IDs, migration drift check                                                         | Database integration tests                               |
| Mobile credential storage                   | Refresh token in Keychain/Keystore (`expo-secure-store`, device-only); access token in memory; no AsyncStorage                           | Mobile unit tests                                        |
| Social access control                       | Role-scoped queries (no IDOR), centralised `RelationshipService`, strict schemas (no mass assignment)                                    | Phase 2 integration tests                                |
| Enumeration resistance (discovery)          | Exact lookup only, per-account limits, identical 404s for hidden/blocked/unknown                                                         | `discovery.test.ts`                                      |
| Upload safety                               | Content sniffing, size and pixel limits, re-encoding, server-generated keys, authorised delivery                                         | `avatar-image`, `adapters`, `profiles` tests             |
| Staff-only data                             | `@RequireStaffRole`, database-backed roles                                                                                               | `blocks-reports.test.ts`                                 |
| End-to-end encryption                       | MLS (RFC 9420) between devices; server stores ciphertext and public MLS data only; delivery-service policy enforced on commits           | `mls.test.ts`, `mls-policy.test.ts`, e2e tests           |
| Realtime security                           | Authenticated handshake, Origin allowlist, closed event contract, per-event authorization and rate limits, expiry/revocation disconnects | `realtime.test.ts`                                       |
| Shared rate limits                          | Redis throttler storage (required in production); configurable messaging limits                                                          | `redis-scaleout.test.ts`, `messaging-operations.test.ts` |
| Local data at rest                          | Sealed stores: non-extractable WebCrypto key (web), Keychain/Keystore key (mobile); wiped at sign-out                                    | `idb-store`, `native-store`, `primitives` tests          |

## Required in later phases

| Phase | Control                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| 2     | Breached-password screening; password change and account recovery (revoking sessions); "sign out everywhere"          |
| 2     | Least-privilege database roles (migration ≠ runtime role; no UPDATE/DELETE on audit); TLS to the database             |
| 2     | Real email provider with SPF/DKIM/DMARC; audit data retention policy                                                  |
| 3 ✓   | Shared rate-limit store (Redis); WebSocket authentication, per-event validation/authorization and rate limits — done  |
| next  | Independent security review of `ts-mls` and OGC's MLS integration (**before production**)                             |
| next  | Safety-number verification state and key-change warnings; periodic MLS self-updates                                   |
| 5, 9  | Role-based authorization (group roles, staff roles) extending `AuthContext`; authorization tests per endpoint         |
| 6     | Upload validation (type sniffing, size limits), malware scanning, private object storage with short-lived signed URLs |
| 8     | Short-lived TURN credentials; signalling authorization per call                                                       |
| 9     | Moderation actions audited; admin console behind separate role and MFA                                                |
| 10    | External penetration test, threat model review, incident response runbook                                             |

End-to-end encryption: implemented with MLS between devices in Phase 3
([ADR-024](../architecture/decisions.md#adr-024-end-to-end-encryption-with-mls-rfc-9420-via-ts-mls),
[encryption.md](../architecture/encryption.md)). The library is not yet independently audited.

## Reporting a vulnerability

Report suspected vulnerabilities privately to ObagaGlobal Ltd (a dedicated security contact
will be published before launch). Do not open public issues for security problems.
