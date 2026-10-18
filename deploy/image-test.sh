#!/usr/bin/env bash
# Builds the image and checks what it promises: it runs as a non-root user, `migrate` can run twice, the api
# starts against a real Postgres and answers /health and /ready, and an unknown command is refused.
# Needs docker. SKIP_BUILD=1 tests an image that is already built. Usage: deploy/image-test.sh [image-name]
set -euo pipefail

image=${1:-orch-image-test}
net=orch-img-$$
trap 'docker rm -f "$net-api" "$net-db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true' EXIT
fail() { echo "image-test: $*" >&2; exit 1; }

[ "${SKIP_BUILD:-}" = 1 ] || docker build --tag "$image" "$(dirname "$0")/.."

[ "$(docker run --rm --entrypoint id "$image" -u)" != 0 ] || fail "the image runs as root"
if docker run --rm "$image" nonsense >/dev/null 2>&1; then fail "an unknown command ran"; fi

docker network create "$net" >/dev/null
docker run -d --name "$net-db" --network "$net" -e POSTGRES_USER=orch -e POSTGRES_PASSWORD=orch \
  -e POSTGRES_DB=orch postgres:18-alpine >/dev/null
# over TCP: while the image initialises, only the unix socket answers
for i in $(seq 60); do
  docker exec "$net-db" pg_isready -h 127.0.0.1 -U orch -d orch -q && break
  [ "$i" -lt 60 ] || fail "postgres did not start"
  sleep 1
done

url=postgres://orch:orch@$net-db:5432/orch
docker run --rm --network "$net" -e DATABASE_URL="$url" "$image" migrate
docker run --rm --network "$net" -e DATABASE_URL="$url" "$image" migrate # idempotent: a second run changes nothing

docker run -d --name "$net-api" --network "$net" -e DATABASE_URL="$url" --health-interval 2s \
  --health-start-period 1s "$image" api >/dev/null
for i in $(seq 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$net-api")" = healthy ] && break
  [ "$i" -lt 60 ] || { docker logs "$net-api" >&2; fail "the api never became healthy"; }
  sleep 1
done
[ "$(docker exec "$net-api" id -u)" != 0 ] || fail "the api runs as root"
# /ready needs the database, /health does not
docker exec "$net-api" bun -e "process.exit((await fetch('http://127.0.0.1:3000/ready')).ok ? 0 : 1)" ||
  fail "/ready is not ok"
echo "image-test: ok"
