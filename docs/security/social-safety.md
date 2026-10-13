# Social safety and access control

Security controls for profiles, contacts, discovery, blocking, reporting and media
(Phase 2). Architecture: [social-graph.md](../architecture/social-graph.md).

## Authorization rules

1. Every social endpoint requires a signed-in **ACTIVE** account (global `AuthGuard`).
2. The acting user comes only from the verified session (`@CurrentAuth()`). No endpoint
   accepts a user ID; other people are addressed by public OGC ID.
3. Relationship and visibility decisions are made only in `RelationshipService`.
4. Objects addressed by ID (contact requests) are loaded **with the caller's role in the
   query** (`recipientId = me` to accept/decline, `senderId = me` to cancel). Anything else is
   indistinguishable from a nonexistent ID (404) — no IDOR, no existence oracle.
5. Staff endpoints require a database-backed staff role; client-supplied role claims are
   ignored.
6. Request bodies are strict Zod schemas: unknown fields (e.g. `userId`, `ogcId`,
   `avatarKey`, `status`) are rejected — no mass assignment.

## Threats and controls

| Threat                            | Control                                                                                                                                                              | Verified by                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| OGC ID enumeration                | 900M random space; exact lookup only; 20 lookups/min **per account** (IP rotation does not help); verified accounts only                                             | `discovery.test.ts`                              |
| Existence oracle                  | Same 404 for nonexistent, inactive, non-discoverable and "blocked you"; block/unblock/report answer identically for unknown IDs                                      | `discovery`, `blocks-reports` tests              |
| Revealing a block                 | Blocked users see "not found", never "blocked"; `BLOCKED` is shown only to the blocker                                                                               | `discovery`, `blocks-reports` tests              |
| Blocked-user bypass               | Requests refused both ways; old requests cannot be accepted across a block; block cancels requests and removes contacts                                              | `blocks-reports.test.ts`                         |
| IDOR on requests                  | Role-scoped queries; third parties, wrong-role parties and malformed IDs all get 404                                                                                 | `contacts.test.ts`                               |
| Duplicate / racing requests       | Partial unique index (one pending per pair, either direction) + 409                                                                                                  | `contacts`, `database` tests                     |
| Request spam                      | 30 requests/hour per account; 7-day cooldown after a decline; `NOBODY` policy                                                                                        | `contacts.test.ts`                               |
| Self-targeting                    | Rejected in services and by CHECK constraints (`*_not_self`)                                                                                                         | `contacts`, `blocks-reports`, `database` tests   |
| Report abuse                      | Controlled categories, no client-set status/actions, one open report per reporter/target/category, 10/hour                                                           | `blocks-reports.test.ts`                         |
| Unauthorized report access        | `@RequireStaffRole('MODERATOR','ADMIN')`; responses use OGC IDs, never internal UUIDs                                                                                | `blocks-reports.test.ts`                         |
| Private data leakage              | Public profiles never include email, internal IDs, sessions, devices, privacy settings; details follow `profileVisibility`                                           | `profiles.test.ts`                               |
| Malicious uploads                 | Content sniffing (JPEG/PNG/WebP only); executables/SVG/HTML rejected; 5 MB limit; 40 MP decode limit; full re-encode                                                 | `avatar-image.test.ts`, `profiles.test.ts`       |
| Image metadata (GPS) leakage      | Re-encoding strips EXIF and all metadata                                                                                                                             | `avatar-image.test.ts`                           |
| Path traversal / unsafe filenames | Client filename ignored; keys `avatars/<uuid>.webp` generated server-side, validated by the adapter and a DB CHECK; resolved paths must stay inside the storage root | `adapters.test.ts`, `profiles`, `database` tests |
| Unauthorized photo access         | Photos served only through the API with the same privacy checks; `Cache-Control: private`                                                                            | `profiles.test.ts`                               |
| Open redirect after sign-in (web) | `?next=` must be a same-site path (`//host` and `/\host` rejected)                                                                                                   | `redirect.test.ts`                               |
| Malicious identity links          | Only `ogc://id/<valid OGC ID>` is accepted; links with extra path/query/fragment are ignored; links never trigger actions                                            | `ogc-link.test.ts`, mobile tests                 |

## Privacy defaults

New profiles start with **bio, photo and join date visible to contacts only**, discoverable by
OGC ID (otherwise nobody could add them), and open to contact requests. Users can hide
themselves from discovery or refuse all requests.

## Known limitations

- Rate limits are per API instance unless `REDIS_URL` is set (required in production since
  Phase 3).
- Blocking covers profiles, discovery, contacts and (since Phase 3) messaging, typing,
  presence and receipts — see [messaging-security.md](messaging-security.md). Calls will
  enforce it when they exist.
- Photo delivery through the API uses bandwidth; a CDN with signed URLs is a later
  optimisation.
- A profile-content moderation pipeline (e.g. image classification) is not in place; reports
  are the current mechanism.
