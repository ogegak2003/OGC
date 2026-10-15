# Encrypted PostgreSQL backups

- `pg-backup.sh`: encrypted backup (OpenPGP public key) with a checksum. It never overwrites.
- `pg-restore.sh`: restores into a **new** database only, after verifying the checksum and
  decrypting.
- `test-backup-restore.sh`: an end-to-end check against the local Docker test database
  (`pnpm backup:check`).

Runbook, schedule, key handling, and what a backup can and cannot recover:
[docs/operations/backup-and-restore.md](../../docs/operations/backup-and-restore.md).

Never commit backups, keys or real environment files. `.gitignore` excludes `*.dump`, `*.gpg`,
`*.asc`, `*.sha256` and `backups/`.
