#!/usr/bin/env bash
# Builds the image and checks what it promises: it runs as a non-root user, `migrate` can run twice, the api
# starts against a real Postgres and answers /health and /ready, and an unknown command is refused.
# Needs docker. SKIP_BUILD=1 tests an image that is already built. Usage: deploy/image-test.sh [image-name]
set -euo pipefail

image=${1:-orch-image-test}
root=$(cd "$(dirname "$0")/.." && pwd)
net=orch-img-$$
scratch=$(mktemp -d)
trap 'docker rm -f "$net-api" "$net-db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
fail() { echo "image-test: $*" >&2; exit 1; }

# The real .dockerignore against canary files, in a context of their own (a FROM scratch build needs no base image):
# secrets, key material and browser-test state must stay out of the context, `.env.example` must stay in.
mkdir -p "$scratch/ctx/deploy" "$scratch/ctx/x" "$scratch/ctx/apps/web/e2e" "$scratch/ctx/apps/web/test-results"
cp "$root/.dockerignore" "$scratch/ctx/"
(cd "$scratch/ctx" && touch .env deploy/.env deploy/.env.local deploy/.env.example x/a.pem x/b.key x/secrets.json \
  apps/web/e2e/.state.json apps/web/test-results/trace.zip keep.txt)
printf 'FROM scratch\nCOPY . /\n' >"$scratch/ctx/Dockerfile"
docker buildx build --quiet --output "type=local,dest=$scratch/out" "$scratch/ctx" >/dev/null
leaked=$(cd "$scratch/out" && find . -type f ! -name Dockerfile ! -name .dockerignore | LC_ALL=C sort | tr '\n' ' ')
[ "$leaked" = "./deploy/.env.example ./keep.txt " ] || fail ".dockerignore lets through: $leaked"

[ "${SKIP_BUILD:-}" = 1 ] || docker build --tag "$image" "$root"

[ "$(docker run --rm --entrypoint id "$image" -u)" != 0 ] || fail "the image runs as root"
# refused with the usage text and EX_USAGE (64), not by crashing for another reason
refused=$(docker run --rm "$image" nonsense 2>&1) && code=0 || code=$?
[ "$code" = 64 ] || fail "an unknown command exited $code, not 64"
case $refused in *"usage: orch-entrypoint"*) ;; *) fail "an unknown command printed no usage: $refused" ;; esac

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
