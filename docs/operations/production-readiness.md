# Production-readiness audit

Updated in Phase 10 (2026-10-15); first written in Phase 9. This audit compares what **this
repository configures and has tested on a developer machine** with what a launch needs. Local
tests passing does **not** make OGC production-ready. Nothing has been purchased, registered,
deployed or exposed: no server, domain, DNS record, certificate, SMTP account, object storage,
push credentials, TURN server or monitoring exists yet.

Legend:

- ✅ implemented and verified locally (still needs a real server to be live);
- 🟡 implemented, but needs operator setup, credentials or infrastructure;
- ❌ missing.

## Summary

| Area                                  | Status | State                                                                                                                                                                                            |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deployment definition (single host)   | ✅     | `docker-compose.prod.yml`: edge, web, API, one-shot migrations, PostgreSQL, Redis; internal network; restart policies; health and readiness gating ([deployment.md](deployment.md))              |
| HTTPS edge configuration              | ✅     | nginx edge: TLS 1.2/1.3, HTTP→HTTPS, HSTS, request IDs, WebSockets, body limits, metrics blocked. Tested with a self-signed certificate only                                                     |
| Domain, DNS, real certificate         | ❌     | None exist. The certbot procedure is documented and has not been run                                                                                                                             |
| Server / hosting                      | ❌     | No server provisioned; no CD pipeline or image registry                                                                                                                                          |
| Production configuration guardrails   | ✅     | Startup refuses: HTTP URLs, insecure cookies, outboxes, local storage, plaintext SMTP, PostgreSQL/Redis without TLS (unless a private network is declared), missing, weak or placeholder secrets |
| Health, readiness, graceful shutdown  | ✅     | Liveness vs readiness (database, migrations, Redis, draining); SIGTERM turns readiness 503 first                                                                                                 |
| Image hygiene                         | ✅     | Non-root containers, read-only filesystems, no env files, dev outbox, keys or source maps in images; build context checked with canaries                                                         |
| PostgreSQL and Redis                  | 🟡     | Internal network, no host ports, passwords required. Managed or TLS instances, a least-privilege role and encryption at rest are not set up                                                      |
| Secrets management                    | 🟡     | One root-only env file outside the repo; no secret manager or rotation                                                                                                                           |
| Object storage (avatars, attachments) | ❌     | No S3-compatible driver; uploads are forced off in production                                                                                                                                    |
| STUN/TURN                             | 🟡     | Supported in configuration; no server running                                                                                                                                                    |
| Push (Expo, FCM, APNs)                | 🟡     | Implemented; credentials not uploaded; no physical-device test                                                                                                                                   |
| Email delivery                        | 🟡     | SMTP implemented; no provider account, domain or DNS records                                                                                                                                     |
| Monitoring, alerting, logs            | 🟡     | Health, readiness, protected metrics, redacted JSON logs, startup notices for missing providers; no collector, dashboards, alerts or uptime checks                                               |
| Backups and restoration               | 🟡     | Encrypted scripts tested locally; **no schedule, off-site copy or staging drill is active**                                                                                                      |
| Migrations and rollback               | ✅/🟡  | One-shot migration job; a failed or half-applied migration blocks readiness (tested); rollback is code-first, the database restore is last resort                                                |
| Mobile signing and store release      | 🟡     | EAS profiles exist; accounts, signing and listings outstanding                                                                                                                                   |
| Independent security review           | ❌     | Not commissioned                                                                                                                                                                                 |

## Verified locally on 2026-10-15

These were run on a Windows 11 developer machine with Docker Desktop, not on a server.

| Command                     | Result                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm deploy:check-stack`   | **Passed.** The production stack, as a throwaway project with a self-signed certificate, ran 30+ checks (listed in [deployment.md](deployment.md#verification)). The project, volume and networks were removed afterwards     |
| `pnpm deploy:check-context` | **Passed.** No canary from the dev outbox, uploads, env files, keys, backups, `.toolchain`, the Android project or `.git` reached the build context (about 5 MB). `SELF_TEST=1` confirmed the check fails when a canary leaks |
| `pnpm check`                | See the Phase 10 summary in [security-review.md](../security/security-review.md)                                                                                                                                              |
| `pnpm backup:check`         | Passed (Phase 9)                                                                                                                                                                                                              |

## Details

### Domain and HTTPS

- **Done:**
  - the edge configuration (`infrastructure/docker/nginx/edge.conf.template`, `edge-proxy.conf`):
    - TLS 1.2/1.3 with the Mozilla intermediate cipher list;
    - unknown host names refused at the handshake;
    - HTTP→HTTPS redirect to the configured domain only;
    - HSTS (no `preload`);
    - an edge-generated `X-Request-Id`;
    - `X-Forwarded-For` set by the edge, matching `TRUST_PROXY_HOPS=1`;
    - WebSocket upgrade for `/api/realtime/`;
    - body limits (100 kB, and 26 MB for `/api/`) and timeouts;
  - the API refuses HTTP URLs in production.
- **Missing:**
  - a domain and DNS;
  - a real certificate, through the documented certbot procedure ([deployment.md](deployment.md#4-certificates));
  - an external TLS scan;
  - universal links and app links on the domain (mobile reset and invitation links).

### Server and deployment pipeline

- **Done:**
  - images: multi-stage builds, non-root users, a cached dependency layer;
  - containers: read-only filesystems, `cap_drop: ALL` and `no-new-privileges`;
  - startup ordering by Compose: databases healthy → `migrate` exits 0 → API ready → web → edge;
  - API scaling with `--scale api=N`.
- **Missing:**
  - a server;
  - an image registry with immutable, signed tags;
  - a CD pipeline (CI runs format, lint, typecheck, tests, build and audit; not the Docker
    checks, which need a Docker host);
  - multi-host or high-availability hosting.

### PostgreSQL and Redis

- **Done:**
  - no published ports, on an `internal` network with no internet access;
  - Redis `requirepass`, running as a non-root user;
  - a persistent database volume;
  - required passwords;
  - the TLS rule enforced by the API, with the declared private-network exception.
- **Missing:**
  - managed or replicated PostgreSQL;
  - a least-privilege runtime role (today the API connects as the owner that also migrates);
  - TLS if the database moves off-host;
  - encryption at rest (a disk or provider setting).

### Environment variables and secrets

- **Done:**
  - startup validation, including weak or placeholder secret rejection (only `https://*.localhost`
    stacks are exempt);
  - `production.env.example` with placeholders the API refuses;
  - deployment env files ignored by Git and Docker;
  - validation errors never print values.
- **Missing:**
  - a secret manager (Compose environment values are visible to `docker inspect` for root);
  - rotation procedures;
  - secret scanning in CI.

### Object storage ❌

`STORAGE_DRIVER` supports only `disabled` and `local`, and `local` is refused in production.
Avatars, encrypted attachments and channel media are therefore **unavailable in production**
until an S3-compatible driver exists, with private buckets, server-side encryption, versioning
and lifecycle rules. This is planned in the roadmap (media phase).

### STUN/TURN 🟡

- **Configured:** `WEBRTC_STUN_URLS`, `WEBRTC_TURN_URLS`, short-lived TURN credentials from
  `WEBRTC_TURN_SECRET` (never sent to clients), and the optional relay-only policy that hides
  IP addresses. There is an example config at `infrastructure/turn/turnserver.conf.example`.
- **Missing:**
  - a running coturn (or managed TURN) with TLS on 443 and a public IP;
  - the firewall's relay port range;
  - monitoring.

### Push notifications 🟡

- **Configured:** the Expo push provider, a durable retrying queue, receipts, and generic
  content.
- **Missing:**
  - **FCM:** the `google-services.json` and FCM V1 service-account key uploaded to EAS.
  - **APNs:** the key uploaded through `eas credentials`.
  - An optional `EXPO_ACCESS_TOKEN` (enhanced push security).
  - A test on physical devices.

Ringing while the app is terminated (CallKit or ConnectionService and VoIP push) is not
implemented.

### Email 🟡

The SMTP provider, templates, password recovery and verification emails are implemented. A
provider account, a verified sending domain, SPF, DKIM and DMARC, and SMTP credentials in the
secret manager are still missing.
See [account-recovery.md](../security/account-recovery.md#email-provider). The Compose stack
deliberately runs with email `disabled`, so recovery answers "unavailable" there.

### Monitoring, alerting and logs 🟡

- **Done:**
  - liveness `GET /api/v1/health`;
  - readiness `GET /api/v1/health/ready` (database, migrations, Redis, draining);
  - Prometheus metrics behind `METRICS_TOKEN`, blocked at the public edge;
  - redacted JSON logs with edge-correlated request IDs;
  - production startup notices naming each missing provider.
- **Missing:**
  - log shipping and retention ([data-retention.md](data-retention.md));
  - a metrics store and dashboards;
  - **alerts**: error rate, readiness, DB and Redis, push failures, `429` rate,
    `REFRESH_TOKEN_REUSE_DETECTED`, lockouts and reset spikes, disk, certificate expiry,
    and sustained `ogc_mls_resync_total{outcome="limited"}` (devices repeatedly losing MLS
    state, or resync abuse);
  - uptime checks;
  - an on-call rota.

### Backups 🟡

The scripts, runbook and local check are in place ([backup-and-restore.md](backup-and-restore.md)).
**Nothing is scheduled and nothing is copied off-site.** Missing:

- the scheduler entry;
- off-site write-only storage;
- the offline private key with named custodians;
- provider PITR;
- staging restore drills.

### Migrations and rollback ✅/🟡

- **Done:**
  - forward-only migrations applied once per deployment by the `migrate` job (Prisma's
    advisory lock prevents overlap), never by API replicas;
  - a failed migration stops the deployment;
  - a half-applied schema makes readiness 503 (tested);
  - no-drift integration tests;
  - additive migrations, so the previous code version runs on the new schema. Example:
    `20261017120000_mls_resync_limits` adds `mls_commits.resync` (`NOT NULL DEFAULT false`;
    existing commits are not resyncs) and an index on (sender device, resync, created at).
    It is applied by the normal `migrate` job; on a very large `mls_commits` table, create the
    index `CONCURRENTLY` beforehand to avoid a long write lock.
- **Rollback:** check out the previous tag and rebuild ([deployment.md](deployment.md#7-migrations-and-rollback)).
  Restoring the database is the last resort.
- **Missing:** a registry for instant image rollback, and a release checklist used in
  practice.

### Mobile signing and stores 🟡

- **Configured:**
  - EAS build profiles (development, preview, production) with `autoIncrement`;
  - bundle and package ID `com.obagaglobal.ogc`;
  - the EAS project ID;
  - iOS cloud builds configured.
- **Missing:**
  - Apple Developer and Google Play accounts;
  - signing credentials managed by EAS (never committed: `.gitignore` excludes keystores and
    profiles);
  - store listings and privacy labels or data-safety forms (they must match
    [data-retention.md](data-retention.md));
  - export-compliance answers (encryption);
  - review builds;
  - a privacy policy URL.

`react-native-webrtc` and the Hermes crypto path must be verified on physical devices before
release.

### Independent review ❌

Before handling real users' data, commission:

- a cryptographic review of `ts-mls` and OGC's MLS integration;
- a penetration test of the API, realtime gateway, web app and password recovery;
- a call-security review;
- a mobile assessment on physical devices.

None has been done.

## Launch blockers (in order)

1. A server; a domain with DNS; certificates with the documented renewal; an external TLS scan.
2. A secret manager; an SMTP provider with SPF, DKIM and DMARC (recovery depends on it).
3. An object storage driver (media stays disabled without it).
4. Monitoring, alerts and uptime checks; scheduled off-site encrypted backups; a staging
   restore drill.
5. A TURN server; FCM and APNs credentials; tests on physical devices.
6. An independent cryptographic review and penetration test.
7. Store accounts, signing and listings; a privacy policy and a legal review of retention.
