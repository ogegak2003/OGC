#!/usr/bin/env bash
# Encrypted PostgreSQL backup for OGC (see README.md in this directory).
#
#   pg-backup.sh --dest DIR --recipient-file PUBLIC_KEY.asc [options]
#
# Writes   DIR/ogc-<db>-<UTC timestamp>.dump.gpg   (pg_dump custom format, encrypted to the
# recipient's OpenPGP public key) and a .sha256 checksum next to it. Only the public key is
# needed here: the machine that makes backups cannot read them. Nothing is ever overwritten.
#
# Options:
#   --dest DIR              Destination directory (required; must exist).
#   --recipient-file FILE   OpenPGP public key to encrypt to (required).
#   --container NAME        Run pg_dump inside this Docker container (default: ogc-postgres-1).
#   --database-url URL      Run pg_dump on this host against URL instead of a container.
#   --db NAME               Database name (container mode; default: $POSTGRES_DB or ogc).
#   --user NAME             Database user (container mode; default: $POSTGRES_USER or ogc).
#   --env-file FILE         Also encrypt this configuration file (secrets!) to <name>.env.gpg.
#
# pg_dump only reads: running a backup never changes the database.
set -euo pipefail
umask 077
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not rewrite /paths passed to docker

die() {
  echo "pg-backup: $*" >&2
  exit 1
}

dest=''
recipient_file=''
container='ogc-postgres-1'
database_url=''
db="${POSTGRES_DB:-ogc}"
user="${POSTGRES_USER:-ogc}"
env_file=''

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) dest="${2:-}"; shift 2 ;;
    --recipient-file) recipient_file="${2:-}"; shift 2 ;;
    --container) container="${2:-}"; shift 2 ;;
    --database-url) database_url="${2:-}"; shift 2 ;;
    --db) db="${2:-}"; shift 2 ;;
    --user) user="${2:-}"; shift 2 ;;
    --env-file) env_file="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ -n "$dest" ] || die '--dest is required (no default destination, by design)'
[ -d "$dest" ] || die "destination directory does not exist: $dest"
[ -n "$recipient_file" ] || die '--recipient-file (an OpenPGP public key) is required'
[ -f "$recipient_file" ] || die "recipient key not found: $recipient_file"
command -v gpg >/dev/null || die 'gpg is not installed'
if [ -n "$env_file" ] && [ ! -f "$env_file" ]; then die "env file not found: $env_file"; fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="ogc-${db}-${stamp}"
out="${dest%/}/${name}.dump.gpg"
partial="${out}.partial"
[ ! -e "$out" ] || die "refusing to overwrite existing backup: $out"
[ ! -e "$partial" ] || die "a previous run left $partial; inspect and remove it first"

cleanup() { rm -f "$partial"; }
trap cleanup EXIT

encrypt() {
  gpg --batch --quiet --no-tty --trust-model always \
    --recipient-file "$recipient_file" --cipher-algo AES256 --compress-algo none \
    --encrypt --output "$1"
}

echo "pg-backup: dumping database '$db'…" >&2
if [ -n "$database_url" ]; then
  command -v pg_dump >/dev/null || die 'pg_dump is not installed (or use --container)'
  pg_dump --format=custom --no-owner --no-privileges --dbname="$database_url" | encrypt "$partial"
else
  command -v docker >/dev/null || die 'docker is not installed (or use --database-url)'
  docker exec "$container" pg_dump --format=custom --no-owner --no-privileges \
    --username="$user" --dbname="$db" | encrypt "$partial"
fi
# pipefail makes a pg_dump failure fatal above; an empty output is a failure too.
[ -s "$partial" ] || die 'backup is empty'

mv -n "$partial" "$out"
[ ! -e "$partial" ] || die "could not move backup into place (exists already?): $out"
trap - EXIT
(cd "$(dirname "$out")" && sha256sum "$(basename "$out")" >"$(basename "$out").sha256")
echo "pg-backup: wrote $out ($(wc -c <"$out") bytes)" >&2

if [ -n "$env_file" ]; then
  env_out="${dest%/}/ogc-config-${stamp}.env.gpg"
  [ ! -e "$env_out" ] || die "refusing to overwrite: $env_out"
  encrypt "$env_out" <"$env_file"
  (cd "$(dirname "$env_out")" && sha256sum "$(basename "$env_out")" >"$(basename "$env_out").sha256")
  echo "pg-backup: wrote $env_out" >&2
fi
echo "$out"
