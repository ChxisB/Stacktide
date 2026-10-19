# 18 Graph / SQL State Backend - Tasks

### STATE-1 - ADR: platform-hosted state  `[x]` S - deps: IAC-10
Do: write `docs/adr/0017-sql-state.md` amending ADR-0009 and D9: opt-in per stack, what is stored, sealing, retention, why default stays GitLab-managed, what is out of scope. **Human gate (changes a ROADMAP decision).**
Done when: you accept or amend the ADR and the ROADMAP D9 row is updated to match.

### STATE-2 - Schema and repository  `[x]` M - deps: STATE-1, VAR-1
Do: additive migration `state_versions` (stack, serial, lineage, sealed blob + wrapped-key columns, size, created by) and `state_locks`; repo with serial/lineage checks, retention pruning, size cap; the key re-wrap list gains the new table.
Done when: db tests - state is not readable from the table; a lower serial and a changed lineage are refused; retention keeps N; the structural re-wrap test passes with the new table listed.

### STATE-3 - HTTP backend routes  `[x]` M - deps: STATE-2, AUTH-6
Do: `GET|POST|DELETE /organizations/:orgId/projects/:projectId/state/:stack` following Terraform's HTTP backend protocol; the caller is a CI job (Basic password = the CI token, state paths only) whose project owns the stack; body cap; audited writes (stack, serial, size - never content); `orch ci login --state` asks for the token. **`/security-review`.** LOCK/UNLOCK and the POST/DELETE lock aliases moved to STATE-4.
Done when: a Terraform-protocol test client reads, writes and deletes; wrong project is 404 and wrong stack 403; oversized body is 413; guard-coverage test passes; canary: no state content in logs, audit or errors.

### STATE-4 - Locking semantics  `[x]` M - deps: STATE-3
Do: `LOCK`/`UNLOCK` on the state and `POST`/`DELETE .../lock` (the same two things), owned by the job and ended with its token; a held lock holds off every other writer (`POST ?ID=`, `DELETE`); a refusal is a 423 carrying the holder's lock info; org-admin `POST .../force-unlock` (audited). Migration `0047_state_locks`. **`/security-review`.**
Done when: two concurrent applies - second gets 423 with the owner; a stale lock expires; force-unlock needs org admin and is audited; a lock cannot be released by another run.

### STATE-5 - Stack wiring  `[x]` S - deps: STATE-3, IAC-10
Do: `stack.yml` `state: gitlab | orch` (default `gitlab`); the generated jobs get the `orch` backend address/credentials via OIDC instead of `TF_HTTP_*` for GitLab.
Done when: pipeline-gen snapshots for both; a stack without the key is unchanged byte for byte.

### STATE-6 - Resource index and query API  `[x]` M - deps: STATE-2
Do: parse resource identity (never attributes) from each written state into `state_resources`, in the write transaction; `GET /stacks/:id/state/resources` with type/provider/module filters and cursor.
Done when: fixtures with secrets in attributes - none reachable through the table or the API; the index matches the state on every write; a bad state file is refused without half-writing.

### STATE-7 - Import from GitLab-managed state  `[x]` M - deps: STATE-3, GL-5
Do: `orch state import <stack>` reads the stack's GitLab-managed state and writes it as version 1 here, refusing if state already exists; never switches the stack by itself. **`/security-review`. First real import is a human gate.**
Done when: mock-GitLab test imports and verifies the serial/lineage; refuses a non-empty target; the switch to `state: orch` remains a separate MR.

### STATE-8 - Backup and restore coverage  `[x]` S - deps: STATE-2, OPS-4
Do: extend `docs/runbook-keys-and-backup.md` and the backup test: restore opens a state version with the same keys.
Done when: the OPS-4 backup test restores a sealed state and reads it back.

### STATE-9 - Spike: resource-level locks and scoped plans  `[x]` S - deps: STATE-4
Do: write findings only (`docs/` note): can the HTTP backend protocol carry anything finer than a whole-state lock? What would a custom backend or provider wrapper need? Recommend build or drop.
Done when: a note with a recommendation; no code. The recommendation is yours to accept.

### STATE-10 - Read-only CLI and UI  `[x]` M - deps: STATE-6
Do: `orch state ls|resources`; a stack page tab with versions (serial, time, size, who) and the resource list. No download, edit or rollback.
Done when: command and component tests incl. empty state; journey test still green.
