# 04 Secrets and Variables - Spec
Prefix: VAR · Milestone: M1 · Status: todo

## Goal
One source of truth for configuration and secrets, per project and environment, encrypted, versioned and recoverable.

## Scope
Envelope encryption; variable + version storage; scope resolution with `${REF}` interpolation; CRUD/reveal/history API; rollback and snapshots; import (.env, JSON, GitLab); search and bulk edit.

## Non-goals
Pushing values anywhere (05), rotation and dynamic secrets (backlog), external secret references (EXT-6).

## Design
- Crypto (D7): AES-256-GCM. Master key from env via a `KeyProvider` interface (KMS later), per-project DEK stored wrapped with a key id, AAD = project id + variable id. Master-key rotation = rewrap DEKs, not re-encrypt values.
- Model: `variables(id, org_id, project_id?, environment_id?, key, kind plain|secret|file, description, current_version_id, deleted_at)`; `variable_versions` is append-only (value_enc, version, created_by, reason).
- Scopes (v1): `org` < `project` < `project+environment`; most specific wins. Org-level environment overrides are not supported yet (shortcut; add when asked).
- Interpolation: `${KEY}` resolves within the same environment's resolved set; cycles and missing refs are errors; a value that references any secret is itself a secret.
- Responses: `plain` values are returned; `secret`/`file` values are never in list/get - only `GET .../value` (maintainer+, audited as `variable.reveal`).
- Key names validated (`^[A-Za-z_][A-Za-z0-9_]*$`, length cap).

## Acceptance
Set variables at org/project/env levels, read the resolved set for an environment, change a value, roll back to an earlier version or snapshot, import a `.env`, and see that no response, log or audit row ever contained a secret value.

## Risks / human gates
VAR-1 (crypto) and any key-handling change is a human gate and needs `/security-review`. Losing the master key loses all secrets - OPS-4 must cover backup.
