#!/usr/bin/env bash
# Restores an encrypted OGC backup into a NEW, EMPTY database (see README.md).
#
#   pg-restore.sh --file BACKUP.dump.gpg --target-db NAME --confirm NAME [options]
#
# Safe by default:
#   * the target database must not exist — this script creates it and never overwrites,
#     drops or cleans an existing database;
#   * --confirm must repeat the target name exactly;
#   * the checksum next to the backup is verified first, and decryption must succeed
#     (a tampered or truncated file fails here, before anything is restored);
#   * restoring a production environment is an operator decision: point the application at
#     the restored database only after checking it (see the runbook).
#
# Options:
#   --container NAME     Docker container with PostgreSQL (default: ogc-postgres-1).
#   --user NAME          Database user (default: $POSTGRES_USER or ogc).
# Decryption uses the private key in the current GnuPG home ($GNUPGHOME).
set -euo pipefail
umask 077
export MSYS_NO_PATHCONV=1

die() {
  echo "pg-restore: $*" >&2
  exit 1
}

file=''
target=''
confirm=''
container='ogc-postgres-1'
user="${POSTGRES_USER:-ogc}"

while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="${2:-}"; shift 2 ;;
    --target-db) target="${2:-}"; shift 2 ;;
    --confirm) confirm="${2:-}"; shift 2 ;;
    --container) container="${2:-}"; shift 2 ;;
    --user) user="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ -n "$file" ] || die '--file is required'
[ -f "$file" ] || die "backup not found: $file"
[ -n "$target" ] || die '--target-db is required'
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "invalid database name: $target"
[ "$confirm" = "$target" ] || die "--confirm must repeat the target database name ($target)"
command -v gpg >/dev/null || die 'gpg is not installed'
command -v docker >/dev/null || die 'docker is not installed'

if [ -f "${file}.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum --check --quiet "$(basename "$file").sha256") ||
    die 'checksum mismatch: the backup is damaged or was modified'
else
  echo 'pg-restore: warning: no .sha256 file next to the backup; relying on decryption only' >&2
fi

psql() { docker exec -i "$container" psql --username="$user" --dbname=postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

exists="$(psql -c "SELECT 1 FROM pg_database WHERE datname = '${target}'")"
[ -z "$exists" ] || die "database '$target' already exists; refusing to restore over it"

# Decrypt fully before creating anything, so a bad file leaves no trace.
plain="$(mktemp)"
trap 'rm -f "$plain"' EXIT
gpg --batch --quiet --no-tty --decrypt --output - "$file" >"$plain" ||
  die 'decryption failed (wrong key, or a damaged or tampered file)'
[ -s "$plain" ] || die 'decrypted backup is empty'

psql -c "CREATE DATABASE \"${target}\""
echo "pg-restore: restoring into new database '$target'…" >&2
docker exec -i "$container" pg_restore --username="$user" --dbname="$target" \
  --no-owner --no-privileges --exit-on-error <"$plain" ||
  die "restore failed; database '$target' is incomplete — inspect it, then drop it"

migrations="$(docker exec "$container" psql --username="$user" --dbname="$target" -qtA \
  -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
users="$(docker exec "$container" psql --username="$user" --dbname="$target" -qtA \
  -c 'SELECT count(*) FROM "users"')"
echo "pg-restore: done — $migrations migrations, $users accounts in '$target'" >&2
