#!/usr/bin/env bash
# Backs up the platform's database to one file (pg_dump custom format).
#
#   DATABASE_URL=postgres://user:pass@host:5432/orch deploy/backup.sh [file]
#
# The file holds ciphertext and WRAPPED data keys, never the master keys (ORCH_MASTER_KEYS). Without those
# keys a restore opens nothing, so keep them somewhere else; see docs/runbook-keys-and-backup.md.
# The URL is visible to other users of this host while the script runs (`ps`). Where that matters, keep the
# password out of it: DATABASE_URL="host=db.internal dbname=orch user=orch" with the password in ~/.pgpass.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to the database to back up}"
out="${1:-orch-$(date -u +%Y%m%dT%H%M%SZ).dump}"
if [ -e "$out" ]; then
  echo "refusing to overwrite $out" >&2
  exit 1
fi

umask 077 # the file is readable by its owner only
tmp=$(mktemp "$out.part.XXXXXX") # made here, not guessed by someone else in a shared directory
if ! pg_dump --format=custom --no-owner --no-privileges --dbname "$DATABASE_URL" --file "$tmp"; then
  rm -f "$tmp" # never leave half a backup that looks like a whole one
  echo "backup failed" >&2
  exit 1
fi
# a hard link fails if $out appeared meanwhile (two backups with the same name): neither overwrites the other
if ! ln "$tmp" "$out" 2>/dev/null; then
  rm -f "$tmp"
  echo "refusing to overwrite $out (or this file system cannot make hard links)" >&2
  exit 1
fi
rm -f "$tmp"
echo "$out"
echo "wrote $out. The master keys are NOT in it: keep ORCH_MASTER_KEYS apart from this file." >&2
