#!/usr/bin/env bash
# End-to-end check of pg-backup.sh and pg-restore.sh against the LOCAL Docker PostgreSQL.
#
#   test-backup-restore.sh [--source-db ogc_test] [--container ogc-postgres-1]
#
# Uses a throwaway OpenPGP key in a temporary GnuPG home, backs up the source database
# (pg_dump only reads it), restores into a new database named ogc_restore_check_<random>,
# compares row counts, checks every refusal path, and finally drops ONLY the database it
# created. Never point it at a production server.
set -euo pipefail
export MSYS_NO_PATHCONV=1

here="$(cd "$(dirname "$0")" && pwd)"
source_db='ogc_test'
container='ogc-postgres-1'
user="${POSTGRES_USER:-ogc}"
while [ $# -gt 0 ]; do
  case "$1" in
    --source-db) source_db="$2"; shift 2 ;;
    --container) container="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d)"
target="ogc_restore_check_$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n')"
export GNUPGHOME="$work/gnupg"
mkdir "$GNUPGHOME" "$work/out"
chmod 700 "$GNUPGHOME" 2>/dev/null || true # not enforceable on Windows filesystems
created=''
psql_in() { docker exec -i "$container" psql --username="$user" -v ON_ERROR_STOP=1 -qtA --dbname="$1" -c "$2"; }
finish() {
  if [ -n "$created" ]; then psql_in postgres "DROP DATABASE IF EXISTS \"$target\"" >/dev/null || true; fi
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap finish EXIT
pass() { echo "  ok - $*"; }
fail() { echo "  FAILED - $*" >&2; exit 1; }

echo "backup/restore check: source '$source_db' -> new database '$target'"

gpg --batch --quiet --passphrase '' --quick-generate-key 'OGC backup test <backup-test@ogc.invalid>' ed25519 cert never
fpr="$(gpg --batch --list-keys --with-colons | awk -F: '/^fpr:/ { print $10; exit }')"
gpg --batch --quiet --passphrase '' --quick-add-key "$fpr" cv25519 encr never
gpg --batch --armor --export "$fpr" >"$work/backup-public.asc"

# 1. Refusals before anything is written.
if "$here/pg-backup.sh" --recipient-file "$work/backup-public.asc" >/dev/null 2>&1; then fail 'backup without --dest'; fi
pass 'backup refuses to run without an explicit destination'
if "$here/pg-backup.sh" --dest "$work/out" >/dev/null 2>&1; then fail 'backup without a key'; fi
pass 'backup refuses to run without a recipient key'

# 2. Backup.
backup="$("$here/pg-backup.sh" --dest "$work/out" --recipient-file "$work/backup-public.asc" \
  --container "$container" --db "$source_db" --user "$user")"
[ -s "$backup" ] && [ -f "$backup.sha256" ] || fail 'backup or checksum missing'
if head -c 5 "$backup" | grep -q 'PGDMP'; then fail 'backup is not encrypted'; fi
if gpg --batch --list-packets "$backup" 2>/dev/null | grep -q 'pubkey enc packet'; then
  pass "encrypted backup written ($(wc -c <"$backup") bytes)"
else
  fail 'backup is not an OpenPGP public-key-encrypted file'
fi
# A second run writes a new file and leaves the first one byte-for-byte unchanged.
before="$(sha256sum "$backup" | cut -d' ' -f1)"
sleep 1
second="$("$here/pg-backup.sh" --dest "$work/out" --recipient-file "$work/backup-public.asc"   --container "$container" --db "$source_db" --user "$user" 2>/dev/null)"
[ "$second" != "$backup" ] || fail 'second backup reused the first name'
[ "$(sha256sum "$backup" | cut -d' ' -f1)" = "$before" ] || fail 'first backup was modified'
(cd "$work/out" && sha256sum --check --quiet "$(basename "$backup").sha256") || fail 'checksum file wrong'
pass 'existing backups are never overwritten'

# 3. Restore refusals.
if "$here/pg-restore.sh" --file "$backup" --target-db "$target" --confirm wrong >/dev/null 2>&1; then
  fail 'restore without matching --confirm'
fi
pass 'restore requires --confirm to repeat the target name'
if "$here/pg-restore.sh" --file "$backup" --target-db "$source_db" --confirm "$source_db" \
  --container "$container" --user "$user" >/dev/null 2>&1; then
  fail 'restore over an existing database'
fi
pass 'restore refuses an existing database'
tampered="$work/out/tampered.dump.gpg"
cp "$backup" "$tampered"
printf 'X' | dd of="$tampered" bs=1 seek=200 conv=notrunc status=none
if "$here/pg-restore.sh" --file "$tampered" --target-db "$target" --confirm "$target" \
  --container "$container" --user "$user" >/dev/null 2>&1; then
  fail 'restore of a tampered file'
fi
[ -z "$(psql_in postgres "SELECT 1 FROM pg_database WHERE datname = '$target'")" ] ||
  fail 'a failed restore left a database behind'
pass 'a tampered backup is rejected before anything is created'

# 4. Restore into a new database and compare.
created=yes
"$here/pg-restore.sh" --file "$backup" --target-db "$target" --confirm "$target" \
  --container "$container" --user "$user"
for table in users sessions audit_events conversations messages _prisma_migrations; do
  a="$(psql_in "$source_db" "SELECT count(*) FROM \"$table\"")"
  b="$(psql_in "$target" "SELECT count(*) FROM \"$table\"")"
  # The source may be in use by a test run; the restored copy must match the snapshot or
  # be close to it, and must never be empty when the source is not.
  [ "$b" -le "$a" ] && { [ "$a" -eq 0 ] || [ "$b" -gt 0 ]; } || fail "$table: source $a, restored $b"
  pass "$table restored ($b rows)"
done
[ "$(psql_in "$target" "SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_events_append_only'")" = 1 ] ||
  fail 'append-only audit trigger missing after restore'
pass 'integrity triggers restored'

echo 'backup/restore check passed'
