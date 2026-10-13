# Dependency policy

## Rules

1. **Exact or tilde-pinned versions** for direct dependencies; the lockfile is committed and
   CI installs with `--frozen-lockfile`.
2. **Minimum release age.** pnpm 11 refuses versions published within the last day by default.
   Do not add `minimumReleaseAgeExclude` entries to get around it; pin the previous release
   and upgrade later.
3. **Install scripts are denied by default.** Only packages listed as `true` under
   `allowBuilds` in `pnpm-workspace.yaml` may run them. Adding one requires review.
4. **Audit gate.** `pnpm audit --audit-level=high` runs in CI; any new high or critical
   advisory fails the build.
5. **Fix order:** upgrade the direct dependency → `overrides` to a patched version in the
   same major → (only when no fix exists) a documented, dated risk acceptance below.
6. **Automated updates** via Dependabot (weekly), grouped by ecosystem (NestJS, Prisma, Expo,
   lint tooling). Expo-managed versions are aligned with `pnpm --filter @ogc/mobile exec expo install --check`.
7. GitHub Actions are pinned to full commit SHAs.
8. **Minimal production images.** Production containers contain runtime dependencies only.
   `.pnpmfile.cjs` drops `@prisma/client`'s optional `prisma`/`typescript` peers, which
   otherwise pull the Prisma CLI, Studio, and TypeScript into the API image
   (728 MB → 393 MB). Changes to `.pnpmfile.cjs` require review.

## Cryptography dependencies (Phase 3)

Cryptographic code is never written in OGC; it comes from these libraries, pinned exactly and
reviewed on every upgrade (read the changelog and advisories, run the e2ee and messaging test
suites, including the Hermes simulation).

| Package                                                                        | Role                                                                     | Notes                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ts-mls` 1.6.4                                                                 | MLS (RFC 9420)                                                           | MIT; passes MLS interop vectors; **not independently audited**; ≥ 1.6.4 required (GHSA-gwp3-968w-m7gv) |
| `@noble/curves` 2.0.1, `@noble/hashes` 2.0.1, `@noble/ciphers` 2.1.1           | Ed25519, X25519, SHA-2, HMAC/HKDF, ChaCha20-Poly1305, XChaCha20-Poly1305 | Audited, dependency-free                                                                               |
| `@hpke/core` 1.9.0, `@hpke/dhkem-x25519` 1.8.0, `@hpke/chacha20poly1305` 1.8.0 | HPKE (RFC 9180) used by MLS                                              | MIT                                                                                                    |
| `expo-crypto` 57.0.3                                                           | Platform CSPRNG on mobile                                                | Pinned below 57.0.4, which was inside the release-age window (see below)                               |

Release-age incident (Phase 3): `expo install` resolved `expo-crypto@57.0.4` (published the
same day) and **automatically wrote a `minimumReleaseAgeExclude` entry**. It was reverted
immediately; `57.0.3` is pinned and the lockfile passes pnpm's supply-chain check. Add new
packages with `pnpm add <pkg>@<version>` and check `pnpm-workspace.yaml` is unchanged after any
`expo install`. `expo-sharing` is likewise pinned to 57.0.22.

Other Phase 3 runtime dependencies: `socket.io`/`socket.io-client` 4.8.3,
`@nestjs/websockets`/`@nestjs/platform-socket.io` 12.1.2, `@socket.io/redis-adapter` 8.3.0,
`ioredis` 5.11.1 (the adapter's supported major), `prom-client` 15.1.3, `express` 5.2.1 (same
version as Nest's, for a route-specific body limit), `expo-audio`, `expo-document-picker`,
`expo-file-system` (SDK 57). Test-only: `fake-indexeddb` 6.2.5.

## Security overrides

Configured in `pnpm-workspace.yaml` → `overrides`.

| Package        | Override             | Advisory                                      | Reached via                |
| -------------- | -------------------- | --------------------------------------------- | -------------------------- |
| `mysql2`       | `<3.23.1` → `3.24.5` | Auth plugin downgrade; unbounded zlib inflate | `prisma` CLI (dev tooling) |
| `deepmerge-ts` | `<8.0.0` → `8.0.2`   | Stack exhaustion on recursive objects         | `@prisma/config`           |

Verified after applying: `prisma generate` and `prisma validate` succeed; full test suite passes.

## Accepted risks

Configured in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`. **Review by 2026-11-30**,
or sooner when a fixed version is published.

| Advisory                                                                 | Package             | Severity | Why accepted                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` ≤3.0.3     | High     | No patched version published. Reached only through Metro/Jest file watching in the mobile **development toolchain**, which processes developer-controlled glob patterns. Not present in any production artifact. |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | `node-forge` ≤1.4.0 | High     | No patched version published. Used by the Expo CLI for local dev-server certificates. Not shipped in the app or the API.                                                                                         |

Moderate findings (not gating, tracked):

| Advisory            | Package             | Notes                                                                                             |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| GHSA-w5hq-g745-h8pq | `uuid` <11.1.1      | Via `xcode` (Expo iOS prebuild). Affects v3/v5/v6 with a caller-supplied buffer; build-time only. |
| GHSA-hp3w-g68c-fv3c | `sprintf-js` ≤1.1.3 | Via Jest coverage tooling; test-time only. No patched version published.                          |
