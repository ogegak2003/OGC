# Backup and restore

Phase 9, reviewed in Phase 10. Scripts: `infrastructure/backup/` (`pg-backup.sh`, `pg-restore.sh`,
`test-backup-restore.sh`). The end-to-end check is `pnpm backup:check`.

> **Current status (2026-10-15).**
>
> - **Exists:** the scripts, verified against a local test database.
> - **Does not exist yet:** a backup schedule, off-site replication, a production key pair or a
>   staging restore drill. No backup of any deployed system runs today.
>
> **Container names.** With `docker-compose.prod.yml` (see [deployment.md](deployment.md#8-backups))
> the database container is `ogc-prod-postgres-1`. The local development stack uses
> `ogc-postgres-1`.
>
> **Restore drills.** Run them on a separate staging host or Compose project, for example
> `docker compose -p ogc-drill -f infrastructure/docker/docker-compose.prod.yml …`, which gets
> its own volume, and point `pg-restore.sh --container` at that project's database container.
> `pg-restore.sh` only creates new databases, so even a drill run by mistake on the production
> host cannot overwrite production data. Use a separate project anyway.
>
> **Object storage.** Avatars and attachments are not covered here: they are disabled in
> production until S3-compatible object storage exists. That storage then needs:
>
> - private buckets with server-side encryption;
> - versioning with lifecycle expiry matched to [data-retention.md](data-retention.md);
> - write-only credentials for the API's upload path;
> - replication to a second region or account, as its backup.

## What a backup can and cannot recover

| Data                                                                              | In the PostgreSQL backup?                     | Recoverable from it?                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Accounts, credentials (Argon2id hashes), profiles, contacts, blocks, reports      | Yes                                           | Yes                                                                                                      |
| Groups, channels, memberships, invitations, settings, call history, audit log     | Yes                                           | Yes                                                                                                      |
| Community channel posts (server-readable by design)                               | Yes                                           | Yes                                                                                                      |
| End-to-end encrypted messages and attachments                                     | Ciphertext only                               | **No plaintext.** Only devices that already hold the keys can decrypt                                    |
| Users' private encryption keys, MLS group secrets, safety-number "verified" marks | **No**: they exist only on devices            | **No.** A backup never recovers them                                                                     |
| Device public keys and key packages                                               | Yes                                           | Yes, but a restored state can be **older** than devices' MLS state (see "restore consequences")          |
| Sessions                                                                          | Token hashes                                  | Restored sessions stay valid until expiry. Rotate them (below) if the backup may have leaked             |
| Redis (rate-limit counters, presence, realtime fan-out)                           | Not backed up                                 | Not needed: ephemeral, rebuilt automatically. After a Redis loss, rate-limit windows simply restart      |
| Uploaded media (avatars, encrypted attachments) on object storage                 | **No**: separate                              | Back up the bucket with the provider's versioning or replication (object storage is not implemented yet) |
| Configuration (`.env`, secrets)                                                   | Optional, separately encrypted (`--env-file`) | Yes, with the backup decryption key                                                                      |

## Encryption and keys

- **Format.** `pg_dump` custom format, piped straight into GnuPG and encrypted to an OpenPGP
  **public key** (AES-256 session key). The plaintext dump never touches the disk on the backup
  side.
- **Key separation.**
  - The backup host holds only the **public** key, so it cannot read backups.
  - The **private** key belongs offline, in a password manager or HSM owned by named
    operators.
  - Keep at least two people able to restore, and test that they can.
- **Credentials.** Backup-storage credentials (for example, bucket write-only keys) are separate
  from both the database credentials and the decryption key.
- **Never in Git.** `.gitignore` excludes `*.dump`, `*.gpg`, `*.asc`, `*.sha256` and
  `backups/`. Never commit backup archives, keys or real env files.

Create the backup key pair once, on an offline machine:

```sh
gpg --quick-generate-key 'OGC backups <ops@your-domain>' ed25519 cert 2y
gpg --quick-add-key <FINGERPRINT> cv25519 encr 2y
gpg --armor --export <FINGERPRINT> > ogc-backup-public.asc   # copy to the backup host
gpg --armor --export-secret-keys <FINGERPRINT>               # store offline only
```

## Taking a backup

```sh
POSTGRES_USER=ogc POSTGRES_DB=ogc \
infrastructure/backup/pg-backup.sh \
  --dest /secure/backups \
  --recipient-file /etc/ogc/ogc-backup-public.asc \
  --container ogc-postgres-1 \
  --env-file /etc/ogc/api.env     # optional: configuration with secrets, encrypted separately
```

- Use `--database-url postgresql://…` instead of `--container` when `pg_dump` runs on the host;
  it should be a read-only role with `sslmode=require`.
- Output:
  - `ogc-<db>-<UTC timestamp>.dump.gpg` plus `.sha256`;
  - with `--env-file`, also `ogc-config-<timestamp>.env.gpg` plus `.sha256`.
- **Safe by default.** There is no default destination. Nothing is overwritten: the script
  writes to `*.partial` and then does a non-clobbering move. `pg_dump` only reads, and the
  script fails clearly on any pipeline error or empty output.

**Schedule and retention (recommended).**

| What                                     | Frequency      | Keep                          |
| ---------------------------------------- | -------------- | ----------------------------- |
| Full logical backup (`pg-backup.sh`)     | Daily          | 7 daily, 4 weekly, 6 monthly  |
| PostgreSQL WAL archiving (provider PITR) | Continuous     | 7 days point-in-time recovery |
| Configuration backup (`--env-file`)      | On each change | Last 10                       |

Copy backups to storage in a **different account and region**. Make that storage write-only
from the backup host (no delete) and set object-lock or lifecycle rules for the periods above.
A managed PostgreSQL service's own snapshots and PITR are a good complement. These scripts stay
useful for provider-independent, encrypted, portable copies.

Backups contain personal data. Their retention is part of the data-retention policy, and
deleted accounts persist in backups until those backups expire.

## Restoring

`pg-restore.sh` only ever restores into a **new** database:

```sh
GNUPGHOME=/secure/restore-gnupg \
infrastructure/backup/pg-restore.sh \
  --file /secure/backups/ogc-ogc-20261015T020000Z.dump.gpg \
  --target-db ogc_restore_20261015 --confirm ogc_restore_20261015 \
  --container ogc-postgres-1
```

The script works in this order:

1. Verifies the `.sha256`.
2. Decrypts fully first, so a tampered or damaged file fails before anything is created.
3. Refuses a target that already exists.
4. Creates the target and restores with `--exit-on-error`.
5. Prints the migration and account counts.

It never drops, cleans or overwrites a database.

**Runbook for a real incident** (production restores need explicit authorization from the
incident owner):

1. Declare the incident, stop writes (scale the API to zero), and record the time.
2. Restore into a new database, as above, on the production server or a replacement.
3. Check it:
   - `prisma migrate status` against it;
   - row counts compared with the last metrics;
   - a sign-in on a staging copy of the app.
4. If the restored backup predates the latest migrations, deploy the **matching** application
   version first, then run `prisma migrate deploy`.
5. Point `DATABASE_URL` at the restored database and start the API. Keep the old database,
   renamed and untouched, for the investigation.
6. **Restore consequences:**
   - Sessions created after the backup no longer exist, so those users sign in again.
   - Sessions revoked after the backup are valid again: **revoke all sessions** if the incident
     could involve stolen tokens (`UPDATE sessions SET revoked_at = now(), revocation_reason =
'ACCOUNT_DISABLED' WHERE revoked_at IS NULL;`, then restart the API).
   - Messages sent after the backup are lost from the server; devices keep what they
     received.
   - MLS groups may be at a later epoch on devices than on the server. Affected conversations
     resynchronise through the normal external-commit path when devices next sync. Test this
     in a staging drill before relying on it.
7. Rotate any secret that could have leaked with the old environment.

**Redis.** Nothing to restore. Start an empty Redis with the same password and URL. Presence
and rate limits rebuild themselves.

## Verification

`pnpm backup:check` (`infrastructure/backup/test-backup-restore.sh`) does the following:

1. Creates a throwaway OpenPGP key in a temporary GnuPG home.
2. Backs up the local **test** database (`ogc_test`, read-only).
3. Restores it into a new `ogc_restore_check_<random>` database and compares row counts.
4. Checks that the append-only audit trigger survived.
5. Proves the refusals:
   - no destination;
   - no key;
   - existing backups untouched by a second run;
   - a wrong `--confirm`;
   - an existing target;
   - a tampered file, which leaves no database behind.
6. Drops **only** the database it created.

Result on 2026-10-15 (local Docker PostgreSQL 18.6, GnuPG 2.4.9): all checks passed.
**Run a restore drill against staging every quarter** and record the time it took. That
measures the real recovery time, which this local check does not.
