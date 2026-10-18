# Runbook: backup, restore and master keys

What to do to keep the platform's data, get it back, and change the keys that protect it (OPS-4). Everything here is
tested against a local Postgres 18 (`packages/db/src/backup.test.ts`, `rewrap.test.ts`); none of it has run on a real
deployment yet, so do the first restore and the first rotation on a copy, not on the only database you have.

## What is where

| Thing | Lives in | Protected by |
|---|---|---|
| Secret variable values, connection tokens, sink URLs and secrets, pending change-request values | the database, as AES-256-GCM ciphertext | a **data key** (DEK) per project / organization / connection / sink |
| Each data key | the database (`variable_keys`, `connections`, `notification_sinks`), **wrapped** | the **master key** |
| The master keys | `ORCH_MASTER_KEYS` in the environment of the api and the worker | whoever can read that environment |

A dump of the database therefore holds ciphertext and wrapped data keys, and the audit log, but **no master key**.
That is the point: a leaked dump alone opens nothing. It is also the risk: **without the master key a backup is
worthless**. Keep `ORCH_MASTER_KEYS` (every key a backup might still need) in a place that is backed up on its own and
is not the place the dumps go.

`ORCH_MASTER_KEYS` is `id:base64,id:base64,...`. The **first** entry wraps new data keys; the others only open what an
older key wrapped. Each key is 32 random bytes, for example `openssl rand -base64 32`; the id is a short label you
choose (`k1`, `2026-10`) and must not be reused for a different key.

## Back up

```sh
DATABASE_URL=postgres://orch:...@db.internal:5432/orch deploy/backup.sh /backups/orch-$(date -u +%F).dump
```

`pg_dump` in the custom format, one consistent snapshot, written readable by its owner only. It dumps to a
temporary name next to the target and puts it in place only when the dump is whole, and never over a file that
exists (also not one that appears meanwhile), so a file that exists is a whole dump. It needs `pg_dump` at least as
new as the server (Postgres 18).

- Do it on a schedule you choose (cron, a CI schedule). The platform does not schedule backups.
- Keep copies off the host the database runs on. A dump holds every encrypted secret and the audit log: treat it as
  you would treat the database.
- The connection string is visible to other users of the host in `ps` while `pg_dump` runs. Where that matters, keep
  the password out of it: set `DATABASE_URL` to a keyword string such as `host=db.internal dbname=orch user=orch` and
  give the password in `~/.pgpass` (or `PGPASSWORD`). The same goes for `restore.sh`.
- There is no point-in-time recovery: you lose what was written after the last dump. If that is too much, use
  Postgres's own continuous archiving (WAL), which is outside this platform.

## Restore

Restore goes into an **empty** database, never over a live one.

```sh
createdb -h db.internal orch_restored
DATABASE_URL=postgres://orch:...@db.internal:5432/orch_restored deploy/restore.sh /backups/orch-2026-10-18.dump
```

`restore.sh` refuses a database that has any table, view or sequence in it, and restores in one transaction, so a
failure (for example a schema or type of the same name that was left behind, which the check does not look for)
leaves the database as it was. Then:

1. Point `DATABASE_URL` of the api and the worker at the restored database.
2. Start them with the **same `ORCH_MASTER_KEYS`** as when the dump was taken (or a list that still contains every
   key the dump's data keys are wrapped by; `keys:rotate --status` below tells you which those are).
3. Run the migrations (`bun packages/db/src/migrate.ts`) if the release you run is newer than the backup's. For the
   same release it changes nothing.
4. Check: sign in, open a project, reveal one secret you know the value of, and run `--status` (below).

A restore with the wrong keys does not fail loudly at start: the first read of a secret fails with a decrypt error.
Do step 4.

Runs and plans that were in flight when the dump was taken are in the dump as they were, and GitLab-side state
(pipelines, merge requests) may be ahead of it. Run a sync plan for each target before trusting a drift status.

## Rotate the master key

Do this when a key may have leaked, when someone who could read the environment leaves, or on your own schedule. It
changes how the data keys are wrapped, not the secrets: no secret is re-encrypted, no value is ever read, and the
secrets stay readable throughout.

1. Generate a new key and pick an id: `openssl rand -base64 32`.
2. Put it **first** in `ORCH_MASTER_KEYS`, keeping the old entries after it: `k2:<new>,k1:<old>`. Roll that out to
   **every** api and worker instance and wait until all of them run with it. An instance that still has only the old
   list wraps anything it creates with the old key, and cannot open anything wrapped by the new one.
3. Move the data keys, with the same environment (`DATABASE_URL`, `ORCH_MASTER_KEYS`):

   ```sh
   bun packages/db/src/rotate-master-key.ts
   ```

   (`bun run keys:rotate` is the same for a local checkout; it reads `.env.example`.) It takes the data keys that the
   current key does not wrap, unwraps each with the key that wrapped it, wraps it with the current one, **checks that
   it opens again**, and only then stores it. It is safe to stop and to run again. It logs the key ids and counts
   (never key material) and exits `0` when nothing is left on an old key, `1` when something is (a data key that could
   not be moved is listed by table and id and a short code) and also when a database error stopped it (what moved
   stays moved: run it again), and `2` when it was called wrongly or the key list is invalid.
4. Run `bun packages/db/src/rotate-master-key.ts --status` (changes nothing). It exits `1` for as long as anything is
   still on an old key, which is the answer and not a fault. **Only when it exits `0` is the old key unused by the
   database.** If it exits `1` with `remaining > 0`, a lagging instance created more old-key wraps: fix
   that instance and run step 3 again.
5. Remove the old entry from `ORCH_MASTER_KEYS` everywhere (`k2:<new>`). Do **not** do this earlier: the old key is the
   only way to open whatever it still wraps.
6. **Backups taken before step 3 are wrapped by the old key.** Keep the old key for as long as you may restore one of
   them, in the same safe place as the rest of your keys. Take a fresh backup after the rotation.

If the old key has **leaked**, rotating is not enough on its own: the data keys are the same, only their wrapping
changed, so someone who holds the old key *and an old dump* can still open everything in that dump. Treat the secrets
in it as exposed and change them at their source (new tokens, new webhook URLs, new variable values).

## When it goes wrong

| Symptom | Likely cause |
|---|---|
| Decrypt errors on every secret after a restore | the keys are not the ones the dump was taken under. Find them; there is no other way in |
| `rotate-master-key` exits 1 with entries in `failed` | `unknown_key`: those rows are wrapped by a key that is not in `ORCH_MASTER_KEYS`, add it and run again. `decrypt_failed` or `bad_format`: the stored wrap is damaged or belongs to another row; restore that row from a backup |
| `--status` stays above 0 | an instance runs with the old list; check every api and worker |
| `restore.sh` says the database is not empty | restore into a new database; do not clear a live one |
| `pg_dump: error: aborting because of server version mismatch` | install a `pg_dump` at least as new as the server |

## What this does not cover

- The master keys come from the environment (ADR-0007): anyone who can read the process environment can read them. A
  KMS-backed provider is the next step and a separate decision.
- Scheduled backups, retention of dumps, encryption of the dump file itself, and point-in-time recovery.
- Restoring a single organization or project out of a dump.
