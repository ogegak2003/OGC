# OGC identity

> **Status: provisional.** The format below is implemented in `@ogc/validation` so that
> every app agrees on it, but it requires owner approval before identities are issued.

## Format

`OGC` followed by a sequence number:

| Sequence number | Canonical identity |
| --------------- | ------------------ |
| 1               | `OGC000001`        |
| 42              | `OGC000042`        |
| 999 999         | `OGC999999`        |
| 1 000 000       | `OGC1000000`       |

Rules:

1. Uppercase `OGC` prefix.
2. Numbers below one million are zero-padded to six digits.
3. Numbers of one million and above use their natural width, with no leading zeros.
4. Every number therefore has **exactly one** canonical form (`OGC0000001` is invalid).
5. `OGC000000` is never issued.

Implementation: `packages/validation/src/ogc-id.ts` (`OGC_ID_PATTERN`, `ogcIdSchema`,
`parseOgcId`, `isOgcId`, `formatOgcId`), with tests alongside. Code that needs an identity
uses the branded `OgcId` type from `@ogc/types`, which can only be produced by validation.

## Open questions for later phases

- **Assignment strategy.** Sequential numbers reveal sign-up order and approximate user
  count, and make identities enumerable. Alternatives: randomised allocation within the
  numeric space, reserved ranges, or vanity identities. Decide before Phase 2.
- **Reserved identities.** e.g. low numbers for ObagaGlobal official accounts.
- **Permanence.** What happens to an identity when an account is deleted (never reissued is
  the safe default).
- **Internal vs public identifiers.** The database primary key should be an internal
  identifier (e.g. UUIDv7), with the OGC identity as a separate unique public attribute.
