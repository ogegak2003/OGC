#!/usr/bin/env bash
# End-to-end check of docker-compose.prod.yml on THIS machine (Windows Docker Desktop or Linux).
#
#   infrastructure/docker/tests/check-prod-stack.sh [--keep]
#
# Starts the production stack as a separate, throwaway Compose project (`ogc-prodcheck`, its own
# volume and networks; your development stack and data are not touched) with a self-signed
# certificate for ogc.localhost and freshly generated random secrets that are never printed.
# Ports bind to 127.0.0.1 only. Checks HTTPS, redirects, headers, WebSockets, limits, readiness,
# migrations, image contents, non-root users, secrets in logs, published ports and graceful
# shutdown, then removes the project (containers, networks, its volume) unless --keep is given.
set -euo pipefail
export MSYS_NO_PATHCONV=1

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
project=ogc-prodcheck
domain=ogc.localhost
http_port="${CHECK_HTTP_PORT:-18080}"
https_port="${CHECK_HTTPS_PORT:-18443}"
keep=no
[ "${1:-}" = "--keep" ] && keep=yes

for tool in docker openssl curl; do command -v "$tool" >/dev/null || {
  echo "missing $tool" >&2
  exit 2
}; done

# Some Windows installers set OPENSSL_CONF to a file that does not exist; fall back to the default.
if [ -n "${OPENSSL_CONF:-}" ] && [ ! -f "$OPENSSL_CONF" ]; then unset OPENSSL_CONF; fi

work="$(mktemp -d)"
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
failures=0
pass() { echo "  ok - $*"; }
fail() {
  echo "  FAILED - $*" >&2
  failures=$((failures + 1))
}
compose() {
  docker compose -p "$project" -f infrastructure/docker/docker-compose.prod.yml \
    --env-file "$(host_path "$work/production.env")" "$@"
}
finish() {
  if [ "$keep" = no ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap finish EXIT

# --- Throwaway certificate and secrets (never printed) -------------------------------------
mkdir -p "$work/tls" "$work/acme"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -subj "/CN=$domain" -addext "subjectAltName=DNS:$domain" \
  -keyout "$(host_path "$work/tls/privkey.pem")" -out "$(host_path "$work/tls/fullchain.pem")" >/dev/null 2>&1
chmod 644 "$work/tls/privkey.pem" # throwaway key: readable by the unprivileged nginx user
secret() { openssl rand -hex 24; }
pg_secret="$(secret)"
redis_secret="$(secret)"
metrics_secret="$(secret)$(secret)"
umask 077
cat >"$work/production.env" <<EOF
OGC_DOMAIN=$domain
TLS_CERT_DIR=$(host_path "$work/tls")
ACME_WEBROOT=$(host_path "$work/acme")
POSTGRES_PASSWORD=$pg_secret
REDIS_PASSWORD=$redis_secret
METRICS_TOKEN=$metrics_secret
PUBLIC_BIND=127.0.0.1
HTTP_PORT=$http_port
HTTPS_PORT=$https_port
EOF

discard="$(host_path "$work/discard")" # native curl on Windows cannot write to /dev/null
https() { curl -sk --max-time 10 --resolve "$domain:$https_port:127.0.0.1" "$@"; }
base="https://$domain:$https_port"

echo "production stack check (project $project, https://$domain:$https_port)"

# --- Edge configuration syntax (rendered exactly as the container renders it) -----------------
if docker run --rm -e OGC_DOMAIN="$domain" --add-host api:127.0.0.1 --add-host web:127.0.0.1 \
  -v "$(host_path "$root/infrastructure/docker/nginx/edge.conf.template"):/etc/nginx/templates/default.conf.template:ro" \
  -v "$(host_path "$root/infrastructure/docker/nginx/edge-proxy.conf"):/etc/nginx/snippets/edge-proxy.conf:ro" \
  -v "$(host_path "$work/tls"):/etc/ogc/tls:ro" \
  nginxinc/nginx-unprivileged:1.30-alpine /docker-entrypoint.sh nginx -t >"$work/nginx-t.log" 2>&1; then
  pass 'edge nginx configuration is valid (nginx -t on the rendered template)'
else
  grep -E 'emerg|error' "$work/nginx-t.log" >&2 || tail -5 "$work/nginx-t.log" >&2
  echo 'edge configuration invalid' >&2
  exit 1
fi
echo "building and starting… (first run builds images; this can take several minutes)"
if ! compose up -d --build --wait --wait-timeout 420 >"$work/up.log" 2>&1; then
  tail -30 "$work/up.log" >&2
  compose ps -a >&2 || true
  compose logs --tail 40 api migrate edge >&2 || true
  echo 'stack did not become healthy' >&2
  exit 1
fi
pass 'stack built and every service healthy (postgres, redis, api, web, edge)'

# --- Startup ordering and migrations ---------------------------------------------------------
migrate_id="$(compose ps -a -q migrate)"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$migrate_id")" = 0 ] && pass 'migrate job ran once and exited 0 before the API started' || fail 'migrate exit code'
if compose run --rm migrate 2>&1 | grep -q 'No pending migrations'; then pass 're-running migrations is a no-op'; else fail 'migration rerun'; fi

# --- HTTPS, redirects, headers ---------------------------------------------------------------
ready="$(https "$base/api/v1/health/ready")"
echo "$ready" | grep -q '"status":"ok"' && echo "$ready" | grep -q '"redis":"ok"' && echo "$ready" | grep -q '"migrations":"ok"' &&
  pass 'readiness through the edge: database, migrations, Redis ok' || fail "readiness: $ready"

redirect="$(curl -s --max-time 10 -o "$discard" -w '%{http_code} %{redirect_url}' --resolve "$domain:$http_port:127.0.0.1" "http://$domain:$http_port/messages?x=1")"
[ "$redirect" = "301 https://$domain/messages?x=1" ] && pass 'HTTP redirects to HTTPS on the configured domain' || fail "redirect: $redirect"
spoofed="$(curl -s --max-time 10 -o "$discard" -w '%{redirect_url}' -H 'Host: evil.example' "http://127.0.0.1:$http_port/")"
[ "$spoofed" = "https://$domain/" ] && pass 'redirect ignores a forged Host header' || fail "redirect with forged host: $spoofed"

headers="$(https -D - -o "$discard" "$base/")"
for header in 'strict-transport-security: max-age=31536000; includeSubDomains' 'content-security-policy: default-src' \
  'x-content-type-options: nosniff' 'permissions-policy: camera=(self), microphone=(self)' 'x-frame-options: DENY'; do
  echo "$headers" | tr -d '\r' | grep -qi "^$header" || fail "missing header: $header"
done
echo "$headers" | tr -d '\r' | grep -qiE '^server: nginx/[0-9]' && fail 'server version disclosed' || true
pass 'web client: HSTS, CSP, nosniff, Permissions-Policy, frame denial; no server version'

api_headers="$(https -D - -o "$discard" -H 'X-Request-Id: attacker-chosen-id-123' "$base/api/v1/health")"
[ "$(echo "$api_headers" | tr -d '\r' | grep -ci '^strict-transport-security:')" = 1 ] && pass 'API responses carry exactly one HSTS header' || fail 'HSTS count on API'
rid="$(echo "$api_headers" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')"
[[ "$rid" =~ ^[0-9a-f]{32}$ ]] && pass 'request IDs come from the edge; a client-supplied ID is replaced' || fail "request id: $rid"

https -o "$discard" -w '%{http_code}' "$base/api/v1/metrics" -H "Authorization: Bearer $metrics_secret" | grep -q 404 &&
  pass 'metrics are not reachable through the public edge, even with the token' || fail 'metrics exposed'
if curl -sk --max-time 10 -o "$discard" --resolve "other.localhost:$https_port:127.0.0.1" "https://other.localhost:$https_port/"; then
  fail 'TLS for an unknown host name was accepted'
else pass 'TLS handshakes for unknown host names are refused'; fi
negotiated() { # protocol flag → the protocol the server agreed to, or nothing
  echo | openssl s_client -connect "127.0.0.1:$https_port" -servername "$domain" "$@" 2>/dev/null |
    awk '/^New, / { sub(/,$/, "", $2); print $2; exit }' || true # (NONE) when refused
}
[ "$(negotiated -tls1_2)" = TLSv1.2 ] && [ "$(negotiated -tls1_3)" = TLSv1.3 ] &&
  pass 'TLS 1.2 and 1.3 negotiate' || fail 'TLS 1.2/1.3 not negotiated'
# The client explicitly allows legacy protocols, so only the server can refuse.
old="$(negotiated -tls1_1 -cipher 'DEFAULT@SECLEVEL=0')"
[ -z "$old" ] || [ "$old" = "(NONE)" ] && pass 'TLS 1.1 is refused by the server' || fail "TLS 1.1 negotiated: $old"

# --- WebSocket, limits, API behaviour --------------------------------------------------------
ws="$(https --http1.1 -i -N --max-time 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H "Origin: https://$domain" "$base/api/realtime/?EIO=4&transport=websocket" 2>/dev/null | head -1 || true)"
echo "$ws" | grep -q ' 101' && pass 'WebSocket upgrade passes through the edge (101)' || fail "websocket: $ws"

# 150 kB bodies, sent from files (too long for a Windows command line).
head -c 150000 /dev/zero | tr '\0' 'a' >"$work/big.txt"
{
  printf '{"email":"'
  cat "$work/big.txt"
  printf '"}'
} >"$work/big.json"
[ "$(https -o "$discard" -w '%{http_code}' -X POST --data-binary "@$(host_path "$work/big.txt")" "$base/")" = 413 ] && pass 'edge limits bodies to the web client (413)' || fail 'web body limit'
[ "$(https -o "$discard" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary "@$(host_path "$work/big.json")" "$base/api/v1/auth/login")" = 413 ] &&
  pass 'API rejects oversized JSON (413)' || fail 'API body limit'
forgot="$(https -X POST -H 'Content-Type: application/json' --data '{"email":"nobody@example.test"}' "$base/api/v1/auth/password/forgot")"
echo "$forgot" | grep -q EMAIL_UNAVAILABLE && pass 'without an email provider, recovery answers "unavailable" (never pretends to send)' || fail "forgot: $forgot"
err="$(https "$base/api/v1/does-not-exist")"
echo "$err" | grep -qiE 'stack|at .*\.js|postgres|redis://' && fail 'error response leaks internals' || pass 'error responses are structured, without internals'

# --- Isolation: ports, users, images ---------------------------------------------------------
for service in postgres redis api web; do
  ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$(compose ps -q "$service")")"
  echo "$ports" | grep -q 'HostPort' && fail "$service publishes a host port: $ports"
done
pass 'postgres, redis, api and web publish no host ports (only the edge does, on 127.0.0.1 here)'
root_services=""
for service in api web edge redis; do
  [ "$(compose exec -T "$service" id -u)" != 0 ] || root_services="$root_services $service"
done
[ -z "$root_services" ] && pass 'api, web, edge and redis run as non-root users' || fail "running as root:$root_services"
[ "$(docker network inspect -f '{{.Internal}}' "${project}_backend")" = true ] &&
  pass 'the backend network (postgres, redis, migrate) is internal: no internet access' ||
  fail 'backend network is not internal'
for service in postgres redis; do
  networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$(compose ps -q "$service")")"
  [ "$networks" = "${project}_backend " ] || fail "$service is attached to: $networks"
done
pass 'postgres and redis are attached to the internal network only'

check_image() { # image, dirs…
  local image="$1"
  shift
  docker run --rm --entrypoint sh "$image" -c "for d in $*; do [ -d \$d ] || continue; find \$d \\( -name node_modules -prune \\) -o \\( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '.dev-outbox' -o -name '.dev-storage' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.gpg' -o -name '*.dump' -o -name '.git' \\) -print; done" |
    grep -v '\.env\.example$' || true
}
api_image="$(docker inspect -f '{{.Config.Image}}' "$(compose ps -q api)")"
migrate_image="$(docker inspect -f '{{.Config.Image}}' "$migrate_id")"
web_image="$(docker inspect -f '{{.Config.Image}}' "$(compose ps -q web)")"
leaks="$(check_image "$api_image" /app)$(check_image "$migrate_image" /repo)$(check_image "$web_image" /usr/share/nginx/html /etc/nginx)"
[ -z "$leaks" ] && pass 'images contain no env files, dev outbox/storage, keys, backups or Git data' || fail "image contents: $leaks"
if docker run --rm --entrypoint sh "$web_image" -c 'find /usr/share/nginx/html -name "*.map" | grep -q .'; then fail 'web image ships source maps'; else pass 'web image ships no source maps'; fi
if docker run --rm --entrypoint sh "$web_image" -c 'grep -rlE "SMTP_PASSWORD|POSTGRES_PASSWORD|REDIS_PASSWORD|METRICS_TOKEN|TURN_SECRET" /usr/share/nginx/html' | grep -q .; then
  fail 'web bundle mentions server secrets'
else pass 'web bundle contains no server secret names'; fi

# --- Secrets never logged --------------------------------------------------------------------
logs="$(compose logs --no-color 2>&1)"
leaked=no
for value in "$pg_secret" "$redis_secret" "$metrics_secret"; do
  case "$logs" in *"$value"*) leaked=yes ;; esac
done
[ "$leaked" = no ] && pass 'no generated secret appears in any container log' || fail 'a secret appeared in the logs'

# --- Failed migration blocks readiness -------------------------------------------------------
compose exec -T postgres psql -U ogc -d ogc -qtA -c \
  "INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('prodcheck-unfinished', 'x', '99999999999999_prodcheck', now(), 0)" >/dev/null
code="$(https -o "$discard" -w '%{http_code}' "$base/api/v1/health/ready")"
compose exec -T postgres psql -U ogc -d ogc -qtA -c "DELETE FROM _prisma_migrations WHERE id = 'prodcheck-unfinished'" >/dev/null
[ "$code" = 503 ] && pass 'a failed or half-applied migration makes the API report not ready (503)' || fail "readiness with unfinished migration: $code"
[ "$(https -o "$discard" -w '%{http_code}' "$base/api/v1/health/ready")" = 200 ] && pass 'readiness recovers once the schema is complete' || fail 'readiness did not recover'

# --- Restart policy and graceful shutdown ----------------------------------------------------
[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$(compose ps -q api)")" = unless-stopped ] && pass 'services restart automatically (unless-stopped)' || fail 'restart policy'
api_id="$(compose ps -q api)"
start=$(date +%s)
compose stop -t 30 api >/dev/null 2>&1
elapsed=$(($(date +%s) - start))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$api_id")"
oom="$(docker inspect -f '{{.State.OOMKilled}}' "$api_id")"
if [ "$elapsed" -lt 30 ] && [ "$oom" = false ] && docker logs "$api_id" 2>&1 | grep -q 'Shutting down: readiness now reports down'; then
  pass "API shut down gracefully on SIGTERM in ${elapsed}s (exit $exit_code, readiness flipped first)"
else
  fail "graceful shutdown (took ${elapsed}s, exit $exit_code)"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "production stack check passed"
else
  echo "production stack check: $failures failure(s)" >&2
  exit 1
fi
