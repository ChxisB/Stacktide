# ADR-0013: Credentials for AWS, Kubernetes and Vault targets
Status: Proposed (built to the approved SPEC, awaiting your review) · Roadmap: EXT-1

## Context
Invariant 3 says the control plane holds no cloud credentials; the CI runner does, through OIDC. Syncing variables to AWS, Kubernetes or Vault from the control plane needs the control plane to call those systems, so it needs something each of them accepts. The SPEC for feature 12 makes this the one designed exception and asks that the credentials be as small as the systems allow, stored through the `connections` table, and that the runner-side alternative be recorded.

## Decision
A target connection is a `connections` row like the GitLab one: non-secret `config` in the open, one secret sealed with the connection's own data key (`packages/crypto`). The secret never leaves `openConnection`, a route, a log line or an audit row. Creating a connection first checks it against the real system and stores nothing if the check fails.

| Type | Config (open) | Secret (sealed) | What the platform asks for |
|---|---|---|---|
| `aws_assume_role` | role ARN, region | the external ID | `sts:AssumeRole` into the role with that external ID (900 s sessions), then `GetCallerIdentity` to see who it became |
| `kubernetes` | API server origin, 1-20 namespaces, optional CA | a service-account token | `SelfSubjectAccessReview` for get, create and patch on Secrets in each namespace |
| `vault_approle` | address, role ID, auth mount, KV v2 mount, path prefix | the AppRole secret ID | login, `capabilities-self` on the data and metadata paths under the prefix, then revoke the client token |

Type names use underscores because `connections.type` allows only `[a-z][a-z0-9_]*`.

AWS has no long-lived key per target. The trust policy of the target role names the platform's own identity as principal, and the platform assumes the role for each call. That identity is read from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and optional `AWS_SESSION_TOKEN` in the environment, and should be allowed to do nothing except `sts:AssumeRole`. Unset, an `aws_assume_role` connection answers 503 `aws_identity_unavailable`. The platform signs STS requests itself (SigV4, checked against AWS's published test vectors) and only ever calls `sts.<region>.amazonaws.com`, built from the region, never from a field a connection could point elsewhere.

Every outbound call goes through one helper: no redirects are followed, the body is capped at 1 MiB, there is a 10 s timeout, and a failure is reduced to a reason (`unauthorized`, `forbidden`, `not_found`, `rate_limited`, `server`, `timeout`, `network`, `invalid`, `unexpected`) with fixed wording. Neither the system's own text nor the credential nor the config can reach an error.

The Kubernetes and Vault addresses must be an `https` origin with no credentials, path or query. A literal loopback host is refused unless the app was started for development.

## Why this exception, and what was left out
- **Runner-side sync** (a CI job runs `orch sync apply` with OIDC to the cloud) keeps invariant 3 whole and is the better end state where a runner can reach the target. It was not chosen as the first build because sync to these targets is then only as available as a pipeline, plans and drift checks need a pipeline round trip, and a cluster or Vault that is not reachable from a runner cannot be synced at all. The adapters are written against the `Remote` seam, so a runner-side executor could reuse them unchanged; that is the upgrade path and nothing here closes it.
- **Per-target long-lived AWS keys** were rejected: they are the worst thing to hold. Assume-role with an external ID holds only an identifier that is useless without the platform's own identity.
- **A credential provider chain for the platform's AWS identity** (IRSA, ECS, instance profile) is not built. Static environment variables are a held credential too. Upgrade when the platform runs where a role is available.

## Consequences
- Compromise of the database plus the master keys now yields a Kubernetes token and a Vault secret ID per connection, and an external ID. Compromise of the platform's environment yields an AWS identity that can assume the registered roles. Keep the roles' permissions to the managed prefix or namespaces.
- The Kubernetes check cannot tell a token with cluster-wide secret access from a namespaced one. RBAC is the real limit; the namespace list is an allowlist the adapter will enforce (EXT-4).
- SSRF is limited to refusing a literal loopback host. Private ranges and DNS rebinding are open, as for notification sinks.
- Not covered: AWS partitions other than `aws`, a path on the Kubernetes server (Rancher proxies), Vault Enterprise namespaces and nested mounts. Each is a marked shortcut in the config schema.
- The key-rewrap job that re-seals secrets after a master key rotation does not exist yet and must include these connections.
- No first call to a real STS, API server or Vault has happened. The three check functions are tested against contract-level fakes written from the vendors' documentation.
