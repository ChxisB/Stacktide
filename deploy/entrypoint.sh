#!/bin/sh
# The image's commands. Anything else is refused rather than run, so a typo does not start a shell.
set -eu
case ${1:-} in
  api) exec bun apps/api/src/index.ts ;;
  worker) exec bun apps/api/src/worker-main.ts ;;
  migrate) exec bun packages/db/src/migrate.ts ;;
  web) exec bun apps/web/src/server.ts ;;
  *)
    echo "usage: orch-entrypoint api | worker | migrate | web" >&2
    exit 64
    ;;
esac
