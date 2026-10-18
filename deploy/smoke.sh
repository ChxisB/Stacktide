#!/usr/bin/env bash
# Starts the self-host stack (deploy/compose.yml) with throwaway settings and checks it end to end: migrate ran, the api and the
# web page answer through the one address, the page is served, and /auth/login sends the browser to the configured GitLab.
# It stops short of a real sign-in, which needs a real GitLab OAuth application (docs/self-host.md, first run).
# Needs docker compose. Uses ORCH_IMAGE if set (an image already built), else builds one. Usage: deploy/smoke.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
port=${SMOKE_PORT:-13001}
work=$(mktemp -d)
export ORCH_ENV_FILE=$work/env WEB_PORT=$port COMPOSE_PROJECT_NAME=stacktide-smoke
compose() { docker compose -f "$here/compose.yml" "$@"; }
trap 'compose logs --no-color >"$work/logs" 2>&1 || true; compose down -v >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
fail() { echo "smoke: $*" >&2; compose logs --no-color --tail 40 >&2 || true; exit 1; }

# the throwaway values never leave this machine; the GitLab address is reserved (RFC 6761) and is only redirected to
password=$(openssl rand -hex 16)
cat >"$ORCH_ENV_FILE" <<ENV
POSTGRES_PASSWORD=$password
ORCH_MASTER_KEYS=k1:$(openssl rand -base64 32)
GITLAB_URL=https://gitlab.example.test
GITLAB_OAUTH_CLIENT_ID=smoke
GITLAB_OAUTH_CLIENT_SECRET=smoke
GITLAB_OAUTH_REDIRECT_URI=http://localhost:3001/auth/callback
ENV
export POSTGRES_PASSWORD=$password

build=--build
[ -z "${ORCH_IMAGE:-}" ] || build=
compose up -d $build

# Requests are made from inside the web container, so no published port is needed (this also works with a remote
# docker daemon, as in GitLab CI). Prints "<status> <redirect>" and then the body.
probe() {
  compose exec -T web bun -e "const r = await fetch('http://127.0.0.1:3001$1', { redirect: 'manual', headers: { accept: 'text/html' } }); console.log(r.status, r.headers.get('location') ?? ''); console.log(await r.text())"
}
for i in $(seq 90); do
  [ "$(probe /ready 2>/dev/null | head -1 | cut -d' ' -f1)" = 200 ] && break
  [ "$i" -lt 90 ] || fail "the stack never became ready"
  sleep 1
done

compose logs migrate --no-color | grep -q "migrations applied" || fail "migrate did not report success"
[ "$(probe /health | tail -n +2)" = '{"status":"ok"}' ] || fail "/health through the web page is not ok"
probe / | grep -qi '<html' || fail "the web page is not served at /"
where=$(probe /auth/login | head -1)
case $where in
  "302 https://gitlab.example.test/oauth/authorize?"*) ;;
  *) fail "/auth/login did not redirect to the configured GitLab: $where" ;;
esac
# the master keys belong to the api, worker and migrate only
if compose exec -T web printenv ORCH_MASTER_KEYS >/dev/null 2>&1; then fail "the web container holds the master keys"; fi
echo "smoke: ok"
