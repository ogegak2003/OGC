# OGC — ObagaGlobal Communication

OGC is a global communication platform built around a permanent public **OGC identity**
(`OGC000001`, `OGC000002`, …) that does not depend on exposing a phone number.

> **Status: Phase 2 — profiles, contacts and identity discovery.** People can create an
> account, manage their profile and privacy, find each other by OGC ID or QR code, add and
> manage contacts, block and report. Messaging and calls are not built yet. See
> [the roadmap](docs/product/roadmap.md).

© ObagaGlobal Ltd. Proprietary — see [LICENSE](LICENSE).

## Repository structure

```text
OGC/
├── apps/
│   ├── api/                 NestJS modular-monolith API (PostgreSQL via Prisma)
│   ├── web/                 React + Vite web client
│   └── mobile/              Expo / React Native client
├── packages/
│   ├── config/              Shared TypeScript configurations (strict)
│   ├── eslint-config/       Shared ESLint flat configs (type-aware)
│   ├── types/               Shared TypeScript types (API contracts, OgcId)
│   ├── validation/          Shared runtime validation (Zod schemas, OGC ID format)
│   └── ui/                  Design tokens — the visual identity, platform-neutral
├── docs/
│   ├── architecture/        System architecture and decision records
│   ├── development/         Setup, environment variables, Git workflow
│   ├── product/             Product overview, OGC identity, roadmap
│   └── security/            Security principles, controls, dependency policy
├── infrastructure/docker/   Docker Compose stack, production Dockerfiles, nginx config
└── .github/                 CI workflow and Dependabot configuration
```

## Technology

| Area       | Choice                                                            |
| ---------- | ----------------------------------------------------------------- |
| Monorepo   | pnpm workspaces, Turborepo                                        |
| Language   | TypeScript 6 (strict) everywhere, ESM                             |
| API        | NestJS 12, Prisma 7 + PostgreSQL 18, Zod, Pino, Helmet, Throttler |
| Web        | React 19, Vite 8                                                  |
| Mobile     | Expo SDK 57, React Native 0.86                                    |
| Testing    | Vitest (API, web, packages), Jest + jest-expo (mobile)            |
| Quality    | ESLint 10 (typescript-eslint strict, type-checked), Prettier      |
| Containers | Docker, Docker Compose                                            |

The reasoning behind these choices is recorded in
[docs/architecture/decisions.md](docs/architecture/decisions.md).

## Quick start

Prerequisites: **Node.js 24**, **pnpm 11** (`corepack enable`), **Docker**.

```bash
pnpm install

# Local database
cp infrastructure/docker/.env.example infrastructure/docker/.env
pnpm db:up

# API configuration
cp apps/api/.env.example apps/api/.env

pnpm --filter @ogc/api db:migrate   # apply database migrations
pnpm dev            # API on :3000, web on :5173, Expo dev server
```

Full instructions: [docs/development/setup.md](docs/development/setup.md).

## Common commands

| Command             | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `pnpm dev`          | Run all apps in development mode                        |
| `pnpm build`        | Build every package and app                             |
| `pnpm lint`         | ESLint across the workspace                             |
| `pnpm typecheck`    | TypeScript checks across the workspace                  |
| `pnpm test`         | All automated tests                                     |
| `pnpm format`       | Format with Prettier (`format:check` to verify only)    |
| `pnpm check`        | Every quality gate CI runs                              |
| `pnpm audit:deps`   | Dependency vulnerability audit (fails on high/critical) |
| `pnpm db:up / down` | Start / stop local PostgreSQL                           |

Run a single workspace with a filter, e.g. `pnpm --filter @ogc/api test`.

## Documentation

- Product: [overview](docs/product/overview.md) · [profiles & contacts](docs/product/profiles-and-contacts.md) · [OGC identity](docs/product/ogc-identity.md) · [roadmap](docs/product/roadmap.md)
- Architecture: [overview](docs/architecture/overview.md) · [identity & authentication](docs/architecture/identity-and-authentication.md) · [social graph](docs/architecture/social-graph.md) · [data model](docs/architecture/data-model.md) · [decisions](docs/architecture/decisions.md)
- Development: [setup](docs/development/setup.md) · [environment variables](docs/development/environment.md) · [Git workflow](docs/development/git-workflow.md)
- Security: [principles & controls](docs/security/security-principles.md) · [authentication](docs/security/authentication.md) · [social safety](docs/security/social-safety.md) · [dependency policy](docs/security/dependency-policy.md)
