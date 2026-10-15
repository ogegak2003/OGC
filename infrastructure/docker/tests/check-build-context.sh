#!/usr/bin/env bash
# Verifies .dockerignore against what Docker ACTUALLY receives as build context.
#
#   infrastructure/docker/tests/check-build-context.sh
#
# Plants uniquely named canary files in every location that must never reach an image
# (development email outbox, local uploads, env files, keys, backups, the Android project,
# the local toolchain, Git metadata), sends the repository to Docker with a probe Dockerfile,
# and fails if any canary arrives or the context is unreasonably large. The canaries are
# removed afterwards; nothing else in the repository is touched.
set -euo pipefail
export MSYS_NO_PATHCONV=1

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
probe_image="${PROBE_IMAGE:-redis:8.4.7-alpine}" # any local image with sh, find and du
max_kb="${MAX_CONTEXT_KB:-51200}"
tag="ogc-ctx-canary-$$"

canaries=(
  "apps/api/.dev-outbox/$tag-verify-email.txt"
  "apps/api/.dev-storage/$tag-upload.bin"
  "apps/api/.env.$tag"
  "infrastructure/docker/$tag.env"
  "infrastructure/docker/production.env"
  "apps/api/$tag.pem"
  "apps/api/$tag.key"
  "$tag.dump.gpg"
  "backups/$tag.dump"
  "apps/mobile/android/$tag.txt"
  ".toolchain/$tag.txt"
  ".git/$tag.txt"
)
created=()
# SELF_TEST=1 also plants a canary in a location that is NOT ignored: the check must then fail.
if [ "${SELF_TEST:-0}" = 1 ]; then canaries+=("apps/api/src/$tag-must-be-detected.txt"); fi
cleanup() {
  for file in "${created[@]}"; do rm -f "$file"; done
  rmdir backups 2>/dev/null || true
}
trap cleanup EXIT

for file in "${canaries[@]}"; do
  if [ -e "$file" ]; then
    # Never overwrite a real file (e.g. an operator's production.env): check it is ignored instead.
    echo "  note - $file exists; checked as-is, not modified"
    continue
  fi
  mkdir -p "$(dirname "$file")"
  printf 'canary %s\n' "$tag" >"$file"
  created+=("$file")
done

dockerfile="FROM $probe_image
COPY . /ctx
RUN found=\"\$(find /ctx -name '*$tag*' -o -path '/ctx/infrastructure/docker/production.env' | head -20)\"; \\
    if [ -n \"\$found\" ]; then echo \"LEAKED INTO CONTEXT:\"; echo \"\$found\"; exit 1; fi; \\
    for dir in .git .toolchain apps/mobile/android apps/api/.dev-outbox apps/api/.dev-storage node_modules; do \\
      if [ -e \"/ctx/\$dir\" ]; then echo \"LEAKED DIRECTORY: \$dir\"; exit 1; fi; done; \\
    if find /ctx -name '.env' -o -name '.env.*' | grep -v '\\.env\\.example\$' | grep -q .; then \\
      echo 'LEAKED ENV FILE:'; find /ctx -name '.env' -o -name '.env.*' | grep -v '\\.env\\.example\$'; exit 1; fi; \\
    size=\"\$(du -sk /ctx | cut -f1)\"; echo \"context size: \$size KB\"; \\
    if [ \"\$size\" -gt $max_kb ]; then echo 'context too large'; exit 1; fi"

echo "build-context check: probing what Docker receives from $root"
log="$(mktemp)"
status=0
printf '%s
' "$dockerfile" | docker build --no-cache --progress=plain -t "$tag" -f - . >"$log" 2>&1 || status=$?
docker image rm "$tag" >/dev/null 2>&1 || true
grep -vE '^#[0-9]+ \[' "$log" | grep -E 'LEAKED|ogc-ctx-canary|context size|too large|ERROR' | sed 's/^#[0-9]* [0-9.]* //' || true
if [ "$status" -ne 0 ] || ! grep -q 'context size:' "$log"; then
  rm -f "$log"
  echo 'build-context check FAILED' >&2
  exit 1
fi
rm -f "$log"
echo 'build-context check passed: no canary, env file, key, backup, toolchain or Android output reached Docker'
