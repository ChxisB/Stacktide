# 18 Graph / SQL State Backend - Spec
Prefix: STATE · Milestone: M5 · Status: in progress (started 2026-10-19 on the standing authorization; ADR-0017)

## Goal
Let a stack keep its Terraform/OpenTofu state in the platform's Postgres - versioned, encrypted, locked and queryable by SQL - as an alternative to GitLab-managed state.

## Scope
ADR; a Terraform HTTP backend served by the API; versions and locks; stack wiring; a resource index you can query; import from GitLab-managed state; read-only UI/CLI.

## Non-goals
Running Terraform in the control plane (D1 stays). Resource-level locking and scoped plans in v1 (see STATE-9). Editing or rolling back state through the UI. Replacing GitLab-managed state as the default.

## Design
- **Decision change:** D9 / ADR-0009 say GitLab-managed state in v1 and graph/SQL state as backlog. Starting this feature is a **ROADMAP decision change and a human gate** (STATE-1 writes the ADR). The default stays GitLab-managed; a stack opts in with `state: orch`.
- **Reference** (Stategraph, read): state in a database, queryable by SQL, resource-level locks, every plan/apply a recorded transaction. Terraform's HTTP backend protocol is a whole-state blob with one lock, so the *graph* and *resource-level lock* parts do not fit it. v1 delivers storage, versions, locks and an index; STATE-9 is a spike on whether more is possible without a custom backend.
- **Protocol:** `GET` state, `POST` state (`?ID=<lock id>`), `DELETE` state, `LOCK`/`UNLOCK` (Terraform's `lock_method`/`unlock_method` can be set to POST/DELETE if a proxy dislikes custom verbs). Validate `serial` and `lineage`; a write that moves the serial backwards is refused.
- **Auth:** the CI job's OIDC principal (AUTH-6), scoped to project and stack; no new credential type.
- **Secrets in state:** state files hold plaintext secrets and cloud ids. They are sealed with a data key like variable values (ADR-0007) and covered by the key re-wrap job; the structural test that lists tables with a wrapped key must list the new one. Responses, logs and audit rows never carry state content.
- **Index:** on each write, parse resource identity only - address, type, provider, module, mode, count/for_each key - into `state_resources`. **No attribute values**, so SQL queries cannot leak secrets. Replaced wholesale per version inside the write transaction.
- **Locks:** one row per stack with owner (run id/principal), operation, created time; expiry for stale locks; force-unlock is an org-admin action and is audited.
- **Import** from GitLab-managed state is a read from GitLab (`packages/gitlab`) and a first write here; the first real import is a human gate.

## Acceptance
A fixture stack with `state: orch` plans and applies against the real HTTP backend protocol (an in-process Terraform-protocol client in tests); two concurrent applies - the second is refused by the lock; a lower serial is refused; the state is sealed at rest (the table holds no plaintext); `GET .../resources?type=` answers from SQL; a restore of a backup still opens the state.

## Risks / human gates
- STATE-1 (ADR, changes D9), key handling for sealed state, and the first real state write/import are human gates. `/security-review` on STATE-3, STATE-4, STATE-7.
- The control plane now holds the state of your infrastructure - a worse breach target than variables. Backups, retention and access need to be as strict as master keys.
- Losing the database loses state; GitLab-managed state is the safer default until backups are proven (OPS-4).

## Open questions
1. Is this wanted now, or after rotation / cost gates / scanning (cheaper and less risky)? Plan assumes last.
2. State version retention: keep the last N (default 20) or by age?
