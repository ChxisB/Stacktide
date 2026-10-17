# 04 Secrets and Variables - Tasks

### VAR-1 - Crypto package  `[ ]` M - deps: FND-4
Do: `packages/crypto`: `KeyProvider` (env-backed), DEK generate/wrap/unwrap with key id, `encrypt/decrypt(value, aad)`, `rewrap(oldKey, newKey)`.
Done when: tests cover round-trip, tamper detection (ciphertext and AAD), wrong key, rotation via rewrap, and that nonces never repeat in 10k encryptions. **Human gate + `/security-review`.**

### VAR-2 - Schema and repository  `[ ]` M - deps: API-2, VAR-1
Do: `variables`, `variable_versions`, per-project wrapped DEK table; repo functions that encrypt on write and never expose ciphertext columns to callers.
Done when: tests cover unique-key rules, soft delete, append-only versions and that raw `SELECT` of the table shows no plaintext.

### VAR-3 - Resolution engine  `[ ]` M - deps: FND-3
Do: Pure functions in `packages/core`: resolve a scope chain into a key/value set for an environment; `${REF}` interpolation with cycle/missing detection; secret-taint propagation.
Done when: table + property tests cover precedence, override, cycles, missing refs, nested refs and taint.

### VAR-4 - Variables API  `[ ]` M - deps: VAR-2, VAR-3, AUTH-3, API-8
Do: create/update/delete/list/get, resolved-set endpoint per environment, version history, `GET .../value` reveal; every mutation and reveal audited.
Done when: endpoint tests pass, and a leak test serialises every response and log line of the suite and asserts no secret plaintext appears.

### VAR-5 - Rollback and snapshots  `[ ]` M - deps: VAR-4
Do: restore a variable to an earlier version (creates a new version); environment snapshot at a point in time (`?at=`) and restore of a whole environment with a dry-run diff first.
Done when: tests cover restore of changed, deleted and added keys, and that dry-run changes nothing.

### VAR-6 - Import  `[ ]` M - deps: VAR-4, GL-4
Do: parse `.env` (quotes, comments, `export`, multiline), JSON; import from existing GitLab project variables (dry-run default, conflict report, masked/protected flags noted).
Done when: parser fixtures from real-world `.env` oddities pass; import is idempotent; conflicts are reported not overwritten unless asked.

### VAR-7 - Search and bulk edit  `[ ]` S - deps: VAR-4
Do: search by key (and by value for `plain` only) across projects; bulk set/rename/delete with a preview step (Envolve-style).
Done when: tests show preview changes nothing, apply is audited once per change, and secret values are never searchable.
