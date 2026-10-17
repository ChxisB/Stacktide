# 12 Extra Sync Targets - Tasks

### EXT-1 - Target credential model and ADR  `[ ]` M - deps: GL-6, SYNC-4
Do: extend `connections` types (aws-assume-role, kubernetes, vault-approle) with validation and a connection test; write the ADR covering the invariant-3 exception and the runner-side alternative. **Human gate + `/security-review`.**
Done when: ADR approved; tests prove secrets are encrypted at rest and never returned.

### EXT-2 - AWS SSM Parameter Store adapter  `[ ]` M - deps: EXT-1, SYNC-1
Do: adapter with path prefix mapping, SecureString for secrets, tags for ownership (so `prune` only touches managed parameters).
Done when: passes the conformance suite (emulator or fake); prune never deletes unmanaged parameters.

### EXT-3 - AWS Secrets Manager adapter  `[ ]` M - deps: EXT-1, SYNC-1
Do: adapter with one secret per environment (JSON) or per key (configurable), version staging handled.
Done when: passes the conformance suite; partial updates don't clobber unrelated keys.

### EXT-4 - Kubernetes Secret adapter  `[ ]` M - deps: EXT-1, SYNC-1
Do: adapter writing `Opaque` Secrets in allowed namespaces, labelled as managed; optional rollout-restart annotation hook.
Done when: passes the conformance suite against `kind` or a fake API server; namespace allowlist enforced.

### EXT-5 - Vault / OpenBao KV adapter  `[ ]` M - deps: EXT-1, SYNC-1
Do: KV v2 adapter with path mapping and version metadata.
Done when: passes the conformance suite against a dev-mode server.

### EXT-6 - External references  `[ ]` M - deps: EXT-1, VAR-3
Do: `vault://` and `aws-sm://` style pointers resolved at read/sync time with caching limits; resolution failures fail the plan.
Done when: tests cover resolution, missing path, permission denied, and that resolved values are never persisted.
