# 12 extra sync targets: 6 of 6 built, nothing has met a real AWS account, cluster or (beyond a dev server) Vault (2026-10-18)

Written for: the maintainer who will review the REVIEW-tagged decisions (ADR-0013's exception to "no cloud credentials in the control plane", the ownership and delete rules per store, what variables may point at) and run the first real sync to each store in a sandbox.

EXT-1..6 `[x]`. Gate: `bun run check` green, 4005 pass + 2 skip (the opt-in real-GitLab run's host check and the opt-in Vault run) + 0 fail (root), 240 pass + 0 fail (web). One local commit per task, nothing pushed. The feature is `done` in the ROADMAP for the code.

| Task | Commit | What |
|---|---|---|
| EXT-1 | 32b1fd9 | Target credential model: `aws_assume_role`, `kubernetes`, `vault_approle` connections (config in the open, one sealed secret, checked against the real system before anything is stored), ADR-0013 (proposed) for the exception to invariant 3 |
| EXT-2 | 2fede5b | AWS SSM Parameter Store adapter (assumed role, ownership tag, `SecureString` for secrets, prefix per target) |
| EXT-3 | d015fd1 | AWS Secrets Manager adapter (per-key or per-scope layout, tag-marked, scheduled deletion on prune) |
| EXT-4 | 508f183 | Kubernetes Secret adapter (namespace allowlist, ownership label, merge-patch with `resourceVersion`); the rollout-restart hook was descoped (use Reloader) |
| EXT-5 | 02fc2f6 | Vault / OpenBao KV v2 adapter (one secret per scope, check-and-set, ownership in custom metadata, prune = a new version); the only store verified against a real server (Vault 1.19.5 dev, opt-in e2e) |
| EXT-6 | 1913c77 | External references: a variable valued `vault://<connection>/<path>#<field>` or `aws-sm://<connection>/<secret>[#<field>]` is read when a sync target is planned or applied and written as a secret, never stored (opt-in per connection with `references: true`) |

No migrations: connection and target rows already carried a free-form `type` and a JSON `config`. Docs: `docs/aws-targets.md`, `docs/kubernetes-targets.md`, `docs/vault-targets.md`, `docs/external-references.md`, `docs/adr/0013-target-credentials.md`. OpenAPI regenerated.

Details, mutation results (ownership, check-and-set, bounds, leaks, reference scoping mutated; survivors listed per task) and review outcomes are in `12-extra-sync-targets/LOG.md`.

## Not done: human gates

- **ADR-0013 is "Proposed".** The platform now holds a sealed Kubernetes token, a Vault secret ID and an AWS external ID per connection, plus a static AWS identity in its environment (`AWS_*`) that can assume the registered roles. The runner-side alternative that keeps invariant 3 whole was not built; the adapters sit behind the `Remote` seam so it can reuse them.
- **No sync to a real AWS account or Kubernetes cluster has run.** Those adapters and the STS/SSM/Secrets Manager/Kubernetes calls are tested against contract-level fakes written from the vendors' documentation. Vault was run once against a dev server. Do one sync to each store in a sandbox before trusting it.
- **First real read of a reference** (a Vault field and a Secrets Manager secret) has not happened.
- **The key-rewrap job (master key rotation) is still unbuilt** for connections (now including these), variable keys, notification and audit-forwarding sinks and change-request pending values.
- No UI, CLI or api-client support for choosing the new target types or for the `references` option (the API accepts them).
- Environment: the Docker VM disk is almost full (other projects' images and a 28 GB build cache); Postgres hit "No space left on device" once during EXT-5. I removed only my own Vault container and image. Prune the shared cache yourself if it recurs.

## Decisions to review (REVIEW-tagged in the LOG; the complete lists are there)

- **Credential model (EXT-1, 13 items):** the invariant-3 exception; the AWS identity is static environment keys (no IRSA or instance profile); SSRF is only a literal-loopback check (private ranges and DNS rebinding are open, and `/test` reasons let an org admin probe the platform's network); the Kubernetes check cannot tell cluster-wide from namespaced access; commercial AWS partition only, no Vault namespaces; and two disclosed changes to committed behaviour (`KUBE_VERBS` get/create/patch, Vault `NEEDS` without `delete`).
- **SSM (EXT-2, 11 items):** the ownership tag is not a boundary against account holders and an existing parameter is managed only once tagged; scopes only as path segments; standard tier only (4096 bytes); `protected: true` is only the owner's claim that IAM guards the prefix; the role needs `ssm:` permissions the connection test does not prove.
- **Secrets Manager (EXT-3, 12 items):** prune is scheduled deletion with a 30-day recovery window, restore-on-recreate is not atomic; per-scope secrets have no compare-and-set; at most 48 plain keys per secret; the `secret` flag is a tag; ARN-like names are refused more strictly than AWS needs.
- **Kubernetes (EXT-4, 12 items):** no scopes (one target per environment namespace); the namespace allowlist is enforced in the adapter, not at target creation; the ownership label is not a boundary and an unlabelled Secret is never adopted; the plain flag lives in an annotation hand edits can flip; a prune leaves an empty Secret; text only, 512 KiB.
- **Vault (EXT-5, 13 items):** verified only against Vault 1.19.5 dev (OpenBao not tried); the metadata (marker, plain flags) is not atomic with the data; a prune writes a new version, so old values stay readable in earlier versions; a metadata-only path is taken over; login and revoke per call with serial reads.
- **References (EXT-6, 13 items):** the form uses a connection name (not the SPEC's illustrative mount); **anyone who may write variables can point at anything the connection's credential can read**, and the opt-in can be set only at creation; a value that starts with `vault://` or `aws-sm://` can no longer be synced as text and a malformed one fails every plan of the project; the plan digest does not cover the stores, so a rotated value is picked up at apply and a no-op line is not rewritten; a retried apply re-reads; a pointer-valued variable is always a secret; the connection test does not check read permission on referenced secrets.

## Findings that matter beyond this feature

- **`value.replaceAll("${", "$${")` escapes nothing in JavaScript** (`$$` in a replacement string is one `$`). EXT-6's round-trip test caught it; use a function replacer wherever text is escaped that way. Worth a grep of the repo.
- A fake that is the only evidence for a vendor API (SSM, Secrets Manager, Kubernetes) can encode a wrong belief into both the code and its tests. Vault's dev server showed three such details in EXT-5 (a `delete` capability the adapter never needs, metadata `create`, how a metadata-only path reads), which is why the other three stores are the first thing to run for real.
- Mutation passes found real test gaps in every task; each survivor was killed by a stronger test or recorded in the LOG. EXT-6 needed three more tests after its first pass (a start anchor, a 101-character connection name, a JSON array read as an object).

## Remaining risks and open follow-ups

- Mutation survivors left on purpose: the snapshot's isolation level (`repeatable read`) has no test (EXT-6 S5), and the rest are listed per task in the LOG.
- A connection deleted between a reference's lookup and its open is a plain 404 without a variable name; 50 reads of one Vault go in parallel (a `shortcut:` note says to serialise if a Vault rate-limits).
- Feature 13 (deploy and operate) is next; OPS-1/OPS-6 wait on FND-6 (a real pipeline).
