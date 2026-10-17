# 12 Extra Sync Targets - Spec
Prefix: EXT · Milestone: M5 · Status: todo

## Goal
Sync the same variables to AWS, Kubernetes and Vault, not only GitLab.

## Scope
Credential model for non-GitLab targets; AWS SSM Parameter Store, AWS Secrets Manager, Kubernetes Secret and Vault/OpenBao KV adapters; external secret references.

## Non-goals
Dynamic secrets and rotation (backlog), targets beyond the four (add via the same recipe).

## Design
- Every adapter passes the SYNC-1 conformance suite; adding a target should be: config schema + adapter + contract test.
- **Invariant 3 exception:** syncing to these targets means the control plane holds credentials. Keep them minimal: AWS assume-role with external ID (no long-lived keys), Kubernetes service-account token scoped to named namespaces, Vault AppRole scoped to a path. Stored via the generic `connections` table, encrypted. EXT-1 writes the ADR and is a human gate.
- Alternative kept open: runner-side sync (a CI job runs `orch sync apply` with OIDC to the cloud) so the control plane keeps no creds - record in the ADR why it was or was not chosen.
- External references (Infisical-style): a variable can hold a pointer such as `vault://kv/app/db#password`; resolved at read/sync time, never stored.

## Acceptance
For each target: plan/apply/drift work against a local emulator in tests (LocalStack, kind, Vault dev server) or contract-level fakes, and no value appears in plans or logs.

## Risks / human gates
Credential model (EXT-1). First real write to each cloud.
