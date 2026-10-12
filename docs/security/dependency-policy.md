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
