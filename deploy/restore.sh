#!/usr/bin/env bash
# Restores a file made by backup.sh into an EMPTY database (create it first, no migrations run on it).
#
#   DATABASE_URL=postgres://user:pass@host:5432/orch_restored deploy/restore.sh <file>
#
# Refuses a database that has a table, view or sequence in it. Anything else that is in the way (a schema, a
# type of the same name) makes pg_restore fail, and its single transaction then leaves the database as it was.
# Afterwards run the migrations (a newer release than the backup's adds its own) and start the platform with
# the SAME master keys the backup was taken under; see docs/runbook-keys-and-backup.md.
set -euo pipefail

file="${1:?usage: DATABASE_URL=<empty database> deploy/restore.sh <file>}"
: "${DATABASE_URL:?set DATABASE_URL to the empty database to restore into}"
if [ ! -f "$file" ]; then
  echo "no such file: $file" >&2
  exit 1
fi

used=$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command \
  "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname not like 'pg_temp%'
   and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')")
if [ "$used" != "0" ]; then
  echo "refusing to restore: the target database is not empty ($used tables, views or sequences). Restore into a new one." >&2
  exit 1
fi

# one transaction: a failure leaves the database as empty as it was
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname "$DATABASE_URL" "$file"
echo "restored $file" >&2
