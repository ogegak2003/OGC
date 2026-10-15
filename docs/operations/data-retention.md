# Data retention

Phase 9. Code: `apps/api/src/modules/retention/retention.service.ts` and the cleanup next to the
code that owns each kind of data. Tests: `apps/api/test/retention.test.ts`.

> The periods below are engineering defaults chosen for security operations and data
> minimisation. They are **not legal advice**. Confirm them with counsel for each jurisdiction
> OGC serves before launch.

## Three kinds of deletion

| Kind                                                          | Who triggers it          | How                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operational cleanup** (this document)                       | Automatic, on a schedule | Deletes records that are finished and older than their retention period. Never active data                                                                           |
| **Preservation for an investigation or a legal request**      | Operators                | A `retention_holds` row for the account suspends operational cleanup of its sessions and audit events until the hold is removed                                      |
| **Deletion at a user's request** (erasure) or required by law | Support or legal process | **Not implemented yet.** It needs its own design (what to delete, what the law requires to keep, effect on other people's conversations) and must not reuse this job |

Holds are created and removed by operators directly in the database, and the reason is
required. Record the case reference in `reason`, never personal data:

```sql
INSERT INTO retention_holds (user_id, reason) VALUES ('<user uuid>', 'Case SEC-2026-014');
DELETE FROM retention_holds WHERE user_id = '<user uuid>';   -- when the case closes
```

## Policies

| Data                                                                                   | Kept                                                                                         | Cleanup                                                                        | Setting (default, limits)                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Active sessions                                                                        | While active (≤ 30 days absolute)                                                            | Never deleted while active                                                     | —                                           |
| Ended sessions (revoked or expired): IP-free metadata, device link, revocation reason  | 90 days after they ended, so "signed-in devices" history and abuse investigations work       | Retention job                                                                  | `RETENTION_SESSION_DAYS` (90, 7–3650)       |
| Email-verification tokens (hashes)                                                     | Until used or expired, then 7 days                                                           | Retention job                                                                  | `RETENTION_TOKEN_DAYS` (7, 1–365)           |
| Password-reset tokens (hashes)                                                         | Until used, expired or superseded, then 7 days                                               | Retention job                                                                  | `RETENTION_TOKEN_DAYS`                      |
| Audit events (security log: IP address, user agent, event type, IDs)                   | 730 days                                                                                     | Retention job; the database refuses deletion of anything younger than 365 days | `AUDIT_RETENTION_DAYS` (730, 365–3650)      |
| Push deliveries (queue rows, generic text only)                                        | 7 days after creation                                                                        | Push worker                                                                    | `PUSH_DELIVERY_RETENTION_DAYS` (7, 1–90)    |
| Call history (metadata; no media is ever stored)                                       | 365 days after the call                                                                      | Call sweep                                                                     | `CALL_HISTORY_RETENTION_DAYS` (365, 1–3650) |
| Unsent attachment uploads (ciphertext not linked to a message)                         | 24 hours                                                                                     | Attachments service (hourly); channel media likewise                           | fixed                                       |
| Accounts, profiles, contacts, messages, group and channel data, device keys, MLS state | As long as the account and conversation exist                                                | **Never** by operational cleanup                                               | —                                           |
| Application logs (stdout, JSON)                                                        | Decided by the log platform: **recommended 30 days**, 90 days for security-relevant warnings | Log platform retention (not configured in this repository)                     | —                                           |
| Metrics (`/api/v1/metrics`, Prometheus format, no personal data)                       | Decided by the metrics store: **recommended 90 days** at full resolution                     | Metrics store (not configured in this repository)                              | —                                           |
| Backups                                                                                | See [backup-and-restore.md](backup-and-restore.md): 7 daily, 4 weekly, 6 monthly             | Backup storage lifecycle rules                                                 | —                                           |

Logs never contain message content, tokens, passwords or request bodies (see
[authentication.md](../security/authentication.md)). They do contain request paths and
account and request IDs, which is why their retention should be short.

## The retention job

- **Schedule.** It runs every `RETENTION_INTERVAL_MS` (default hourly) on every API instance,
  and can be turned off with `RETENTION_ENABLED=false`. Each task takes a PostgreSQL advisory
  lock, so concurrent instances skip work another instance is doing.
- **Bounded.** It deletes `RETENTION_BATCH_SIZE` rows per statement (default 1 000) and at
  most `RETENTION_MAX_BATCHES` statements per task per run (default 20). A backlog drains over
  several runs instead of in one long transaction.
- **Idempotent.** A run only selects rows that are finished and older than the cutoff, so
  repeating it is harmless.
- **Safe by construction.**
  - Active sessions cannot match: the cutoff is at least 7 days in the past, and an active
    session is neither revoked nor expired.
  - Tokens match only when used or expired.
  - Nothing else is touched: no accounts, devices, keys or messages.
  - Accounts under a retention hold are skipped.
- **Audit events.** The table stays append-only. The database trigger rejects every UPDATE,
  and every DELETE except one made in a transaction that opts in with
  `SET LOCAL ogc.audit_retention = 'on'`. Even then it rejects rows younger than 365 days.
  A misconfiguration or a bug in the application therefore cannot erase recent security
  history.
- **Record.** Each run that deletes something records one `RETENTION_PURGED` audit event with
  counts only.

## Not covered yet

- Automated user-initiated account deletion (erasure) and data export.
- Deletion of devices that have had no session for a long time (device rows anchor keys and
  history; their cleanup needs the device-continuity work).
- Retention of reports and moderation records (Phase 9 moderation tooling).
