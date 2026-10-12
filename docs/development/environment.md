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

| Variable            | Default       | Description                                                             |
| ------------------- | ------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`          | `development` | `development`, `test`, or `production`                                  |
| `HOST`              | `0.0.0.0`     | Bind address                                                            |
| `PORT`              | `3000`        | HTTP port                                                               |
| `LOG_LEVEL`         | `info`        | Pino level (`silent` in tests)                                          |
| `CORS_ORIGINS`      | _(empty)_     | Comma-separated exact origins; must be `https://` in production         |
| `TRUST_PROXY_HOPS`  | `0`           | Number of trusted reverse proxies (affects client IP for rate limiting) |
| `RATE_LIMIT_TTL_MS` | `60000`       | Rate-limit window                                                       |
| `RATE_LIMIT_MAX`    | `120`         | Requests per window per client                                          |
| `DATABASE_URL`      | **required**  | `postgresql://` connection string                                       |

## Adding a variable

1. Add it to the schema with a type, constraints, and (if safe) a default.
2. Add it to the relevant `.env.example` with a comment.
3. Add a row to the table above.
4. Add a test if it carries a security rule.
