# OGC identity

Every OGC account has a permanent, public **OGC ID** — the way people find and contact each
other, without exposing a phone number or email address.

## Format

`OGC` followed by **9 random digits**, the first of which is not zero:

| Canonical      | Displayed         |
| -------------- | ----------------- |
| `OGC482731905` | `OGC 482 731 905` |
| `OGC914205377` | `OGC 914 205 377` |

- **Random:** drawn with a cryptographically secure generator — never sequential, never
  derived from time, row numbers, email, or phone number. IDs reveal nothing about sign-up
  order or user numbers.
- **Unique:** guaranteed by the database; collisions are retried with a new random ID.
- **Immutable:** a database trigger prevents an issued ID from ever changing.
- **Human-friendly:** shown in groups of three; input like `ogc 482 731 905` is normalised.
- **Safe to share:** it identifies an account but grants no access.

Why 9 digits rather than 6: a 6-digit space holds only 900 000 IDs — not enough for a
global platform, and random guesses would hit real accounts most of the time. 9 digits give
900 million IDs ([ADR-008](../architecture/decisions.md#adr-008-random-9-digit-ogc-ids),
pending owner approval).

Implementation: `packages/validation/src/ogc-id.ts` (format, normalisation, display) and
`apps/api/src/modules/identity` (secure generation and collision handling).

## Sharing by QR code

An OGC QR code encodes only the public identity link `ogc://id/OGC482731905` — never
passwords, tokens, keys, or private account data. Scanning will open the person's profile
and contact flow (Phase 2). Once a public web domain is approved, the link becomes an https
universal link so it also works without the app installed.

## Open questions

- **Reserved identities** (e.g. memorable IDs for ObagaGlobal official accounts).
- **Vanity IDs** — whether users may choose or pay for memorable IDs (affects fairness and
  enumeration).
- **Deleted accounts** — IDs are never reissued (recommended default).
