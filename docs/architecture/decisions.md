# Architecture decision records

Short records of significant decisions: context, decision, consequences. Add a new entry
rather than editing an accepted one; mark superseded entries.

---

## ADR-001: Modular monolith

**Status:** Accepted (Phase 0)

**Context.** OGC's long-term scope is broad (messaging, media, calls, moderation…) but the
team and traffic are small today. Microservices would add network failure modes,
distributed transactions, and operational cost before they deliver value.

**Decision.** A single NestJS API with strictly bounded domain modules (see
[overview](overview.md#module-boundary-rules)).

**Consequences.** Simple deployment and refactoring now. Boundary discipline (module-owned
tables, events for side effects) is required so modules can be extracted later.

---

## ADR-002: TypeScript 6.0, not 7.0

**Status:** Accepted (Phase 0)

**Context.** TypeScript 7 (the native compiler) is the latest release, but
`typescript-eslint` — which provides our type-aware lint rules — supports
`typescript >=4.8.4 <6.1.0`.

**Decision.** Pin `typescript ~6.0.3` workspace-wide (Expo SDK 57 also uses 6.0).

**Consequences.** Full type-aware linting. Revisit when typescript-eslint supports TS 7.

---

## ADR-003: Prisma 7 stable, not the 8.0 release candidate

**Status:** Accepted (Phase 0)

**Context.** npm's `latest` tag for the `prisma` CLI points to `8.0.0-rc.*`, while
`@prisma/client`'s `latest` is `7.10.0`.

**Decision.** Use Prisma **7.10.0** (CLI and client) with the `prisma-client` generator,
ESM output, and the `@prisma/adapter-pg` driver adapter. Connection settings live in
`prisma.config.ts`.

**Consequences.** Stable, matched versions. Upgrade to 8 after its general release.

---

## ADR-004: ESM throughout

**Status:** Accepted (Phase 0)

**Context.** NestJS 12 is published as ESM only.

**Decision.** All workspaces are ES modules (`"type": "module"`, `NodeNext` resolution in
Node code), except the Expo app, which follows Expo's bundler conventions.

**Consequences.** Relative imports in Node code use explicit `.js` extensions.

---

## ADR-005: Vitest everywhere except mobile; no SWC

**Status:** Accepted (Phase 0)

**Context.** Nest dependency injection needs `emitDecoratorMetadata`. The usual Vitest
recipe uses SWC, but SWC 1.16.18's native addon refuses to load on hosts whose `C:\` drive
grants broad write permissions (as on the primary development machine). Vite 8's Oxc
transformer reads `experimentalDecorators`/`emitDecoratorMetadata` from `tsconfig.json`.

**Decision.** Vitest (Oxc transform) for API, web, and packages. Jest via `jest-expo` for the
mobile app, as Expo recommends. The `@swc/core` optional peer of `@nestjs/cli` is
installed but its install script is denied; the Nest CLI builds with `tsc`.

**Consequences.** One fewer native dependency. API end-to-end tests verify that DI works.

---

## ADR-006: Shared packages are compiled; `ui` holds design tokens only

**Status:** Accepted (Phase 0)

**Context.** Packages must be consumable by Node (API), Vite (web), and Metro (mobile).
Web and mobile have different rendering primitives (DOM vs React Native).

**Decision.** Shared packages compile to ESM + type declarations in `dist/` (Turborepo
builds them before dependants). `@ogc/ui` contains platform-neutral **design tokens** with
no React dependency; each client builds its own components from them.

**Consequences.** One source of truth for the visual identity; component libraries per
platform can be added later (e.g. `packages/ui-web`) without changing tokens.

---

## ADR-007: One React version across the monorepo

**Status:** Accepted (Phase 0)

**Context.** Expo SDK 57 pins React 19.2.3; React 19.3 is available.

**Decision.** Web also uses React 19.2.3.

**Consequences.** No duplicate React type conflicts. Web upgrades React with Expo SDK
upgrades.
