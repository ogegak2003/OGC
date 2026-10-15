# Deploying OGC

Phase 10 runbook. Read it start to finish once before the first deployment.

| Status                              | Meaning                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented and checked locally** | `docker-compose.prod.yml`, the TLS edge, readiness and graceful shutdown, image and build-context checks (see [Verification](#verification))                                    |
| **Not done: needs your accounts**   | a server, a domain and DNS, a real certificate, SMTP, object storage, push credentials, TURN, monitoring, off-site backups ([production-readiness.md](production-readiness.md)) |

Nothing in this repository deploys anything by itself. Every command below is run by an operator.

## 1. What runs where

```
Internet ──443/80──► edge (nginx, TLS) ─┬─► web  (nginx, static web client)     network: frontend
                                        └─► api  (NestJS, N replicas)           networks: frontend + backend
                                              │
                    migrate (one-shot) ───────┤                                 network: backend (internal:
                    postgres (volume) ◄───────┤                                   no internet, no host ports)
                    redis (ephemeral) ◄───────┘
```

| Service    | Image / build                                       | Ports                                        | State                               | Notes                                                                        |
| ---------- | --------------------------------------------------- | -------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `edge`     | `nginxinc/nginx-unprivileged:1.30-alpine` + config  | **only** public ports: 80 → 8080, 443 → 8443 | none                                | TLS, HTTP→HTTPS, request IDs, WebSockets, body limits, HSTS                  |
| `web`      | `web.Dockerfile` (static build, unprivileged nginx) | none                                         | none                                | CSP and security headers                                                     |
| `api`      | `api.Dockerfile` `runtime` (non-root `node`)        | none                                         | none                                | Readiness `GET /api/v1/health/ready`; liveness `GET /api/v1/health`          |
| `migrate`  | `api.Dockerfile` `migrate`                          | none                                         | none                                | `prisma migrate deploy`, runs once per `up`, must exit 0 before `api` starts |
| `postgres` | `postgres:18.6-alpine`                              | none                                         | **volume `ogc-prod_postgres-data`** | The only persistent data on the host. Back it up                             |
| `redis`    | `redis:8.4.7-alpine`, password, no persistence      | none                                         | memory only                         | Rate limits, presence, realtime fan-out; safe to lose                        |

Startup order is enforced by Compose:

1. `postgres` and `redis` become healthy.
2. `migrate` exits 0.
3. `api` becomes **ready** (database, migrations and Redis OK).
4. `web` becomes healthy.
5. `edge` starts.

A failed migration stops the deployment at step 2. A failed readiness check stops it at step 3.

## 2. Prerequisites

**Linux server (staging and production).**

- A recent 64-bit distribution with **Docker Engine** and the **Compose plugin ≥ 2.20** (for
  `up --wait`). Docker must start at boot: `sudo systemctl enable --now docker`.
- 2 vCPU, 4 GB RAM and 40 GB disk at minimum. The database volume grows with use; watch the
  disk.
- A firewall that allows only 22 (SSH, from your address), 80 and 443:

  ```sh
  sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
  ```

  Docker-published ports bypass `ufw` rules. That is why only `edge` publishes any.

- `git`, `certbot`, `gnupg`, and `curl`.
- A domain whose A/AAAA record points at the server. **Not configured anywhere yet.**

**Windows (development).**

- Docker Desktop, Node.js 24.18.0, pnpm 11 (`corepack enable`), and Git for Windows (Git
  Bash runs the `.sh` checks).
- Day-to-day work: `pnpm install`, `pnpm db:up` (PostgreSQL and Redis on 127.0.0.1), and
  `pnpm dev` (see [setup.md](../development/setup.md)).

## 3. Configuration (without showing secrets)

All production settings live in **one file outside the repository**, readable only by root.

```sh
sudo mkdir -p /etc/ogc /etc/ogc/tls /var/www/ogc-acme
sudo install -m 600 -o root -g root infrastructure/docker/production.env.example /etc/ogc/production.env
sudoedit /etc/ogc/production.env        # replace every REPLACE_… value
```

- **Generating a secret.** Run this per secret and paste the result straight into the editor.
  Do not print it anywhere else.

  ```sh
  openssl rand -base64 33 | tr -d '/+=' | cut -c1-40
  ```

- **Checking which keys are set, without values:**

  ```sh
  sudo grep -oE '^[A-Z_]+=' /etc/ogc/production.env
  ```

- **Never run:**
  - `cat` on the env file;
  - `docker compose config` (it prints interpolated secrets);
  - `docker inspect` on the API container (environment section);
  - `env` inside containers.

  Do not paste any of their output into tickets or chats.

- The file is read by Compose, not baked into images. Images contain no configuration.
  `.dockerignore` keeps `*.env`, `.env*`, keys, backups and the development email outbox out
  of the build context, and `pnpm deploy:check-context` proves it.

**Checklist.**

| Setting                                            | Required     | Notes                                                                                                              |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `OGC_DOMAIN`                                       | yes          | Public host name. `WEB_APP_URL` becomes `https://OGC_DOMAIN`                                                       |
| `TLS_CERT_DIR`, `ACME_WEBROOT`                     | yes          | See [section 4](#4-certificates)                                                                                   |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD`              | yes          | Random, ≥ 16 characters. The API refuses weak, default or placeholder values in production                         |
| `EMAIL_TRANSPORT=smtp` with `EMAIL_FROM`, `SMTP_*` | for recovery | TLS is enforced. Without it, verification and password recovery are unavailable (stated in logs and API answers)   |
| `PUSH_PROVIDER=expo` (+ `EXPO_ACCESS_TOKEN`)       | for push     | After FCM and APNs credentials are uploaded with `eas credentials`                                                 |
| `METRICS_TOKEN`                                    | optional     | ≥ 32 random characters. `/api/v1/metrics` is blocked at the edge: scrape from a monitoring container on the host   |
| `WEBRTC_*`                                         | optional     | TURN for calls across networks                                                                                     |
| uploads                                            | **off**      | `STORAGE_DRIVER` is forced to `disabled`: production refuses local disk, and object storage is not implemented yet |

**What the API checks at startup** (`apps/api/src/config/env.schema.ts`, tests in
`env.schema.test.ts`). It refuses to start, naming the variable but never its value, when:

- `WEB_APP_URL` or CORS origins are not HTTPS, or cookies are not `Secure`;
- the development email or push outbox, or local disk storage, is selected;
- Redis is missing;
- SMTP is configured without TLS, or with only half its settings;
- PostgreSQL or Redis has no TLS (`sslmode=require|verify-ca|verify-full`, `rediss://`). The
  exception is an explicitly declared single-host private network, which
  `docker-compose.prod.yml` declares (`DATABASE_TLS`/`REDIS_TLS=private-network`) because both
  services sit on an internal network with no ports;
- any password or token is missing, shorter than 16 characters, or a known placeholder or
  default. Only the local production-like stack at `https://*.localhost` is exempt.

After it starts, the API logs one line per missing provider ("No email provider…", "No object
storage…", "No push provider…", "No TURN server…") so that none of them goes unnoticed.

## 4. Certificates

The edge needs `fullchain.pem` and `privkey.pem` for `OGC_DOMAIN` in `TLS_CERT_DIR`. They must
be readable by the unprivileged nginx user (uid 101) and no one else. The procedure below uses
Let's Encrypt with certbot on the host. It has **not** been run: no domain exists yet.

1. **First certificate, before the stack exists.** Port 80 is still free, so use standalone
   mode:

   ```sh
   sudo certbot certonly --standalone -d YOUR_DOMAIN --agree-tos -m YOU@YOUR_DOMAIN --no-eff-email
   ```

2. **Renewals go through the running edge.** It serves `/.well-known/acme-challenge/` from
   `ACME_WEBROOT`. Switch the renewal method once:

   ```sh
   sudo certbot reconfigure --cert-name YOUR_DOMAIN --webroot -w /var/www/ogc-acme
   ```

3. **Deploy hook.** It copies the files with the right owner and reloads nginx. Save it as
   `/etc/letsencrypt/renewal-hooks/deploy/ogc-edge.sh` and make it executable (`chmod 700`):

   ```sh
   #!/bin/sh
   set -eu
   install -m 640 -o root -g 101 "$RENEWED_LINEAGE/fullchain.pem" /etc/ogc/tls/fullchain.pem
   install -m 640 -o root -g 101 "$RENEWED_LINEAGE/privkey.pem"   /etc/ogc/tls/privkey.pem
   cd /opt/ogc && docker compose -f infrastructure/docker/docker-compose.prod.yml \
     --env-file /etc/ogc/production.env exec -T edge nginx -s reload || true
   ```

   Run it once by hand after step 1, setting `RENEWED_LINEAGE=/etc/letsencrypt/live/YOUR_DOMAIN`.

4. **Test renewal:** `sudo certbot renew --dry-run`. The certbot package installs a twice-daily
   timer.
5. Monitor expiry from outside, for example with the uptime checker.

**Not set up yet:**

- HSTS `preload`: add it only once you are sure every subdomain will always be HTTPS.
- OCSP stapling.
- A CDN or load balancer in front of the edge. If you add one, raise `TRUST_PROXY_HOPS` and
  forward its client address.

## 5. First deployment

```sh
sudo git clone <your repository URL> /opt/ogc && cd /opt/ogc
git checkout <release tag>                      # deploy tags, not a moving branch
COMPOSE="docker compose -f infrastructure/docker/docker-compose.prod.yml --env-file /etc/ogc/production.env"
sudo $COMPOSE up -d --build --wait --wait-timeout 600
sudo $COMPOSE ps                                 # every service healthy; migrate "Exited (0)"
curl -fsS https://YOUR_DOMAIN/api/v1/health/ready   # {"status":"ok",…,"checks":{…}}
sudo $COMPOSE logs --tail 50 api                 # look for the "No email provider…" style notices
```

`--wait` returns non-zero if any service fails to become healthy. Inspect the failure with:

```sh
sudo $COMPOSE ps -a
sudo $COMPOSE logs --tail 100 migrate api
```

**Smoke test.** Do it by hand in a browser:

- the site loads over HTTPS with a padlock, and `http://` redirects;
- register, verify the email (needs SMTP), sign in, send a message between two accounts, and
  make a call (needs TURN across networks).

**Scaling the API.** Run `sudo $COMPOSE up -d --scale api=2 --wait`, then reload the edge with
`sudo $COMPOSE exec edge nginx -s reload`. nginx resolves `api` at start or reload. Migrations
still run once, in `migrate`.

## 6. Day-to-day operations

| Task                        | Command (with `$COMPOSE` as above)                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                      | `sudo $COMPOSE ps`                                                                                                                                                                                         |
| Readiness (public)          | `curl -fsS https://YOUR_DOMAIN/api/v1/health/ready`                                                                                                                                                        |
| Readiness (inside the host) | `sudo $COMPOSE exec api wget -qO- http://127.0.0.1:3000/api/v1/health/ready`                                                                                                                               |
| Logs                        | `sudo $COMPOSE logs --tail 200 --timestamps api` (JSON, secrets redacted: tokens, cookies, passwords and bodies are never logged)                                                                          |
| Follow one request          | Take the `x-request-id` response header and run `sudo $COMPOSE logs api \| grep <id>`. The edge sets the ID                                                                                                |
| Restart one service         | `sudo $COMPOSE restart api` (graceful: in-flight requests finish and sockets close within 30 s; clients reconnect. With a single API replica, requests fail during the few seconds the container restarts) |
| After a server reboot       | Nothing to do: Docker starts at boot and every long-running service is `restart: unless-stopped`. Check with `sudo $COMPOSE ps`                                                                            |
| Apply a new release         | `git fetch --tags && git checkout <new tag>`, take a backup ([section 8](#8-backups)), then `sudo $COMPOSE up -d --build --wait`                                                                           |
| Run migrations only         | `sudo $COMPOSE run --rm migrate` (idempotent; "No pending migrations" when current)                                                                                                                        |

## 7. Migrations and rollback

- **Workflow.** Migrations are committed and forward-only. `prisma migrate deploy` runs in the
  `migrate` job, once per deployment, before any API replica starts. Prisma also takes a
  database advisory lock, so two concurrent runs cannot interleave. The API never migrates.
- **Failure.** `up` stops: the API keeps running the **previous** containers if they were up,
  and the new ones never start. A half-applied migration makes readiness report 503 (tested),
  so `up --wait` fails and, on a first deployment, the edge never starts. On a running stack
  the existing edge keeps forwarding (it does not health-check), so act at once. Read `sudo $COMPOSE logs migrate`, fix the
  cause, then resolve the migration as the [Prisma docs describe](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing)
  (`prisma migrate resolve`). Never edit `_prisma_migrations` by hand in production.
- **Application rollback.** Run `git checkout <previous tag>` and then `sudo $COMPOSE up -d
--build --wait`. This is safe **because OGC's migrations so far are additive**, so the
  previous code runs on the newer schema. Keep that rule: a destructive change needs an
  expand-and-contract plan over two releases.
- **Database rollback** means restoring a backup. It is the last resort and loses every write
  made since the backup. See the runbook in [backup-and-restore.md](backup-and-restore.md).
- **Faster rollbacks.** Images are built on the server from a tag. A registry with immutable,
  signed image tags would allow faster rollbacks and is recommended (not set up).

## 8. Backups

The scripts and procedures are in [backup-and-restore.md](backup-and-restore.md). In this stack
the database container is `ogc-prod-postgres-1`:

```sh
POSTGRES_USER=ogc POSTGRES_DB=ogc infrastructure/backup/pg-backup.sh \
  --dest /var/backups/ogc --recipient-file /etc/ogc/ogc-backup-public.asc \
  --container ogc-prod-postgres-1
```

**Prerequisites. None of these is configured yet, and no backup runs today.**

1. The backup key pair was generated **offline**. Only `ogc-backup-public.asc` is on the
   server.
2. `/var/backups/ogc` exists (`chmod 700`).
3. A scheduler entry exists, for example root's crontab, using `flock` so runs never overlap:

   ```
   15 2 * * * flock -n /run/ogc-backup.lock /opt/ogc/infrastructure/backup/pg-backup.sh --dest /var/backups/ogc --recipient-file /etc/ogc/ogc-backup-public.asc --container ogc-prod-postgres-1 >> /var/log/ogc-backup.log 2>&1
   ```

   The script prints file names and sizes only, never credentials.

4. Off-site replication to write-only storage in another account or region exists.
5. A restore drill has been done on a staging server.

Redis needs no backup.

## 9. Staging verification

Before production, deploy the same tag to a staging server with its own domain, secrets and
database. Never copy production data to staging; restore drills use backups, never the live
database. Check:

- [ ] `up --wait` succeeds, and `migrate` exits 0.
- [ ] Readiness is `ok` with `database`, `migrations` and `redis` all `ok`.
- [ ] `http://` redirects to `https://`.
- [ ] TLS is graded A by an external TLS scanner.
- [ ] Response headers include HSTS, the CSP and `nosniff`.
- [ ] Registration, email verification, password reset, messaging, a call and push on two
      physical devices all work.
- [ ] `docker ps` shows host ports only on the edge.
- [ ] Logs contain no tokens or passwords (spot-check with `grep`).
- [ ] A restart of `api` drops no messages: clients reconnect.
- [ ] A backup and restore drill completes into a new database.
- [ ] A reboot brings everything back.

## 10. Incident response

| Symptom                                              | First checks                                                                                                                       | Action                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database down** (readiness `database: down`, 503s) | `sudo $COMPOSE ps postgres`, `sudo $COMPOSE logs --tail 100 postgres`, disk space `df -h`                                          | Restart postgres (`sudo $COMPOSE restart postgres`). The API reconnects by itself and readiness returns to ok. If data is corrupt, **stop writes** (`sudo $COMPOSE stop api`) and follow the restore runbook into a **new** database. Never delete the volume                             |
| **Redis down** (`redis: down`)                       | `sudo $COMPOSE logs --tail 100 redis`                                                                                              | `sudo $COMPOSE restart redis`. Nothing is lost except counters and presence. While it is down, readiness reports 503 (alert on it) and API requests that need Redis (rate limits, realtime) fail. The edge does not health-check: it keeps forwarding                                     |
| **Email failing** (resets not arriving)              | `sudo $COMPOSE logs api \| grep -i smtp` (shows the provider's error _code_, never addresses or links); the provider's status page | The API keeps working. Requesters still get the generic answer, and undeliverable reset links are retired automatically. Fix the credentials or quota, restart `api`, and ask affected users to request a new link                                                                        |
| **Migration failed during deploy**                   | `sudo $COMPOSE logs migrate`, then `sudo $COMPOSE ps`                                                                              | Previous API containers keep serving when they were running. Do not retry blindly: find the cause, restore the schema with `prisma migrate resolve` or a restore into a new database, or roll the code back to the previous tag. A half-migrated API reports not ready (503); alert on it |
| **Certificate expired**                              | The browser shows a warning; `sudo certbot certificates`                                                                           | `sudo certbot renew`, then the deploy hook. Check that port 80 reaches the edge                                                                                                                                                                                                           |
| **Disk full**                                        | `df -h`, `docker system df`                                                                                                        | Remove old images (`docker image prune`), not volumes. Grow the disk                                                                                                                                                                                                                      |

## Verification

These checks exist in the repository and run on a developer machine:

| Command                     | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                | Format, lint, typecheck, build and every test, including production configuration validation, readiness and shutdown behaviour                                                                                                                                                                                                                                                                                                                  |
| `pnpm deploy:check-context` | What Docker receives as build context: canary files planted in every location that must never reach an image (dev email outbox, uploads, env files, keys, backups, `.toolchain`, Android output, `.git`) do not arrive, and the context is small. `SELF_TEST=1` proves the check can fail                                                                                                                                                       |
| `pnpm deploy:check-stack`   | Starts `docker-compose.prod.yml` as a separate throwaway project with a self-signed certificate. It checks: HTTPS, redirects, headers, request IDs, WebSocket upgrade, body limits, blocked metrics, refused unknown TLS names and TLS 1.1, published ports, the internal network, non-root users, image contents, secrets absent from logs, readiness on a broken migration, restart policy and graceful shutdown. Then it removes the project |
| `pnpm backup:check`         | Encrypted backup and restore into a new database (from Phase 9)                                                                                                                                                                                                                                                                                                                                                                                 |

The results of the run on 2026-10-15 are in [production-readiness.md](production-readiness.md).
