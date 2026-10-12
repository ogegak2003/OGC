# Development setup

## Prerequisites

| Tool                   | Version                                         | Notes                                                       |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Node.js                | 24 (see `.nvmrc`)                               |                                                             |
| pnpm                   | 11                                              | `corepack enable` uses the version pinned in `package.json` |
| Docker                 | Recent Docker Desktop / Engine with Compose v2+ | For PostgreSQL and production-like containers               |
| Expo Go or an emulator | —                                               | Optional, for running the mobile app                        |

## First run

```bash
pnpm install

# 1. Database
cp infrastructure/docker/.env.example infrastructure/docker/.env
pnpm db:up                      # PostgreSQL 18 on 127.0.0.1:5432

# 2. API configuration
cp apps/api/.env.example apps/api/.env

# 3. Run everything
pnpm dev
```

| App    | URL / command                                                                     |
| ------ | --------------------------------------------------------------------------------- |
| API    | <http://localhost:3000/api/v1/health> (readiness: `/api/v1/health/ready`)         |
| Web    | <http://localhost:5173> — proxies `/api` to the API                               |
| Mobile | Expo dev server; press `a` (Android), `i` (iOS), or scan the QR code with Expo Go |

Run one app: `pnpm --filter @ogc/api dev` (or `@ogc/web`, `@ogc/mobile`).

> **Port already in use?** Change `POSTGRES_PORT` (and the port in `apps/api/.env`
> `DATABASE_URL`), `API_PORT`, or `WEB_PORT` in `infrastructure/docker/.env`.

## Production-like stack

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile app up --build
```

Starts PostgreSQL, the API image, and the web image (nginx) at <http://localhost:8080>,
with the API reachable same-origin at `/api`.

## Database (Prisma)

| Command (from `apps/api`) | Purpose                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `pnpm db:generate`        | Generate the Prisma client (also runs automatically before build/test/typecheck) |
| `pnpm db:validate`        | Validate `prisma/schema.prisma`                                                  |
| `pnpm db:migrate`         | Create and apply a migration in development                                      |
| `pnpm db:migrate:deploy`  | Apply committed migrations (deployments)                                         |

Phase 0 defines no models; the first migration arrives in Phase 1.

## Quality gates

`pnpm check` runs everything CI runs: Prettier check, ESLint, TypeScript, tests, and
builds. Run it before pushing. Individual gates: `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit:deps`.

`pnpm test` limits Turborepo to two concurrent test tasks: starting DOM-environment and Jest
workers in parallel on a typical laptop can exceed Vitest's worker start-up timeout.

## Editor

Recommended VS Code extensions are listed in `.vscode/extensions.json`. Formatting uses
Prettier with the repository config; `.editorconfig` enforces LF line endings and 2-space
indentation.
