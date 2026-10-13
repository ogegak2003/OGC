# Environment variables strategy

## Rules

1. **All configuration comes from the environment.** No credentials, hosts, or keys in
   source code.
2. **Only `.env.example` files are committed.** They contain placeholders and safe local
   defaults. `.gitignore` excludes `.env` and `.env.*` (except `.env.example`).
3. **Validated at startup.** Each server app parses its environment with a schema and
   refuses to start if anything is missing or invalid. Error messages name the variable,
   never its value.
4. **Client variables are public.** Anything prefixed `VITE_` (web) or `EXPO_PUBLIC_`
   (mobile) is embedded in the shipped bundle. Never put secrets there.
5. **Real process environment wins** over `.env` files, so deployments inject values
   through the platform (secret manager, orchestrator), never by shipping `.env` files.
6. **Different secrets per environment.** Local defaults (e.g. `change-me-local-only`) are
   never reused in shared environments.

## Files

| File                                 | Used by                               | Copy to                      |
| ------------------------------------ | ------------------------------------- | ---------------------------- |
| `apps/api/.env.example`              | API (Nest `ConfigModule`, Prisma CLI) | `apps/api/.env`              |
| `apps/web/.env.example`              | Vite (public values only)             | `apps/web/.env.local`        |
| `apps/mobile/.env.example`           | Expo (public values only)             | `apps/mobile/.env.local`     |
| `infrastructure/docker/.env.example` | Docker Compose                        | `infrastructure/docker/.env` |

## API variables

Source of truth: `apps/api/src/config/env.schema.ts`.

| Variable                                  | Default                            | Description                                                                                                                            |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                | `development`                      | `development`, `test`, or `production`                                                                                                 |
| `HOST`                                    | `0.0.0.0`                          | Bind address                                                                                                                           |
| `PORT`                                    | `3000`                             | HTTP port                                                                                                                              |
| `LOG_LEVEL`                               | `info`                             | Pino level (`silent` in tests)                                                                                                         |
| `CORS_ORIGINS`                            | _(empty)_                          | Comma-separated exact origins; must be `https://` in production                                                                        |
| `TRUST_PROXY_HOPS`                        | `0`                                | Number of trusted reverse proxies (affects client IP for rate limiting)                                                                |
| `RATE_LIMIT_TTL_MS`                       | `60000`                            | Rate-limit window                                                                                                                      |
| `RATE_LIMIT_MAX`                          | `120`                              | Requests per window per client                                                                                                         |
| `DATABASE_URL`                            | **required**                       | `postgresql://` connection string                                                                                                      |
| `WEB_APP_URL`                             | `http://localhost:5173`            | Web client URL for links in emails; `https://` in production                                                                           |
| `EMAIL_TRANSPORT`                         | `disabled`                         | `disabled` (send nothing) or `outbox` (development files; rejected in production)                                                      |
| `EMAIL_OUTBOX_DIR`                        | `.dev-outbox`                      | Where the outbox writes emails                                                                                                         |
| `COOKIE_SECURE`                           | `true` in production, else `false` | Secure flag and `__Host-`/`__Secure-` cookie prefixes; must be `true` in production                                                    |
| `STORAGE_DRIVER`                          | `disabled`                         | `disabled` (uploads refused) or `local` (development files; rejected in production)                                                    |
| `STORAGE_LOCAL_DIR`                       | `.dev-storage`                     | Where the local storage adapter keeps media                                                                                            |
| `TEST_DATABASE_URL`                       | —                                  | Tests only: disposable database (name must end in `_test`; reset on every run)                                                         |
| `REDIS_URL`                               | _(unset)_                          | `redis://`/`rediss://`. Shared rate limits, presence and realtime fan-out. Optional for one local instance; **required in production** |
| `TEST_REDIS_URL`                          | —                                  | Tests only: Redis for `redis-scaleout.test.ts` (use a spare database number, e.g. `/15`)                                               |
| `METRICS_TOKEN`                           | _(unset)_                          | Bearer token for `GET /api/v1/metrics` (≥ 32 chars). Unset = endpoint returns 404                                                      |
| `PUSH_PROVIDER`                           | `disabled`                         | `disabled`, `outbox` (development files; rejected in production) or `expo`                                                             |
| `PUSH_OUTBOX_DIR`                         | `.dev-outbox/push`                 | Where the push outbox writes notifications (tokens are truncated)                                                                      |
| `EXPO_ACCESS_TOKEN`                       | _(unset)_                          | Optional Expo push access token                                                                                                        |
| `RATE_LIMIT_MESSAGE_SEND`                 | `60`                               | Messages per minute per account                                                                                                        |
| `RATE_LIMIT_CONVERSATION_CREATE_PER_HOUR` | `30`                               | Conversations opened per hour per account                                                                                              |
| `RATE_LIMIT_ATTACHMENT_UPLOAD_PER_HOUR`   | `100`                              | Attachment uploads per hour per account                                                                                                |
| `RATE_LIMIT_REACTION`                     | `120`                              | Reaction changes per minute                                                                                                            |
| `RATE_LIMIT_EDIT`                         | `30`                               | Edits per minute                                                                                                                       |
| `RATE_LIMIT_DELETE`                       | `60`                               | Deletes per minute                                                                                                                     |
| `RATE_LIMIT_RECEIPT`                      | `600`                              | Read/delivered receipts per minute                                                                                                     |
| `RATE_LIMIT_SYNC`                         | `600`                              | Sync/list/history/download requests per minute                                                                                         |
| `RATE_LIMIT_E2EE`                         | `120`                              | Device-key, key-package, commit and Welcome calls per minute                                                                           |
| `RATE_LIMIT_TYPING`                       | `60`                               | Typing events per minute (realtime)                                                                                                    |
| `RATE_LIMIT_PRESENCE`                     | `60`                               | Presence subscriptions per minute (realtime)                                                                                           |
| `RATE_LIMIT_SOCKET_CONNECT`               | `30`                               | Realtime connections per minute, per client IP and per account                                                                         |

Web: `VITE_API_BASE_URL` (optional, default same-origin `/api`). Mobile:
`EXPO_PUBLIC_API_BASE_URL` (public; the realtime connection uses the same origin).

## Adding a variable

1. Add it to the schema with a type, constraints, and (if safe) a default.
2. Add it to the relevant `.env.example` with a comment.
3. Add a row to the table above.
4. Add a test if it carries a security rule.
