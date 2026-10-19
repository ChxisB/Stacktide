# ADR-0014: Holding credentials to mint secrets
Status: Accepted (the recommended decision, taken on your instruction to make them; amend or reverse it here) · Roadmap: ROT-9

## Context
Rotation (ROT-1 to ROT-8) and leases (ROT-10, ROT-11) need a provider that makes a credential at another system. The providers people ask for first, a Postgres role and an AWS IAM access key, need an **administrative** credential: a database role that can create roles, an IAM identity that can call `iam:CreateAccessKey`. Invariant 3 says the control plane holds no cloud credentials, and [ADR-0013](0013-target-credentials.md) made one designed exception, for target connections that **write** to a bounded place (a namespace, a path prefix, a role's session). A credential that **creates access** is a different thing: whoever has the database and the master keys could mint new access in the customer's accounts, not only write a secret to a place the customer named.

## Decision
1. **The platform holds no new long-lived administrative credential to mint secrets.** A provider whose job is to create credentials in a system the platform holds no connection to today (a database, an IAM account) is not built. v1 has the providers that need none: `random`, which makes a string and touches nothing, and `gitlab-token`.
2. **The case in hand is the GitLab connection, and it is not new.** `gitlab-token` rotates and leases through a GitLab connection the organization already made. GitLab refuses to rotate another token without a personal access token with the `api` scope, so that is the least this provider can ask for. Use a dedicated bot user that is Maintainer only on the projects whose tokens rotate, and not a person's token: what the platform can mint is then what that user can. This adds a use of a credential the platform already holds, not a credential.
3. **Postgres roles and AWS IAM keys are refused for now, not postponed.** A later provider for them replaces this decision and needs all of:
   - its own ADR;
   - an administrative credential that can create access only inside a named boundary: for AWS, `sts:AssumeRole` (as in ADR-0013) into a role that may create keys for one named user; for Postgres 16 and later, a `CREATEROLE` role that administers only the roles it created, never a superuser;
   - an opt-in on the connection, as `references` is, so that a connection made for syncing cannot mint;
   - a conformance run and a revoke path that survives a provider error.
4. **The runner-side alternative is the way to rotate those systems today.** A CI job already holds the cloud identity through OIDC. It makes the credential, writes it as a variable version through the API (`orch vars set`, under a CI principal), and the platform's part is the schedule, the history, the audit and the sync. This keeps invariant 3 whole. It was not built as a provider because the platform would then only know a rotation was due, not that it happened, and nothing here prevents adding a "due" notification later.
5. **Leases in v1 are `gitlab-token` only.** A `random` lease would be a string with nothing to revoke, so it would not be a lease.

## Leases: limits
| Limit | Value | Why |
|---|---|---|
| Default TTL | 1 hour | what a CI job needs |
| Minimum TTL | 60 seconds | below the sweeper's own resolution it is not a promise |
| **Maximum TTL** | **24 hours**, a constant, not a setting | a lease that lasts longer is a rotation; a longer cap is a change to this ADR |
| Live leases per principal | 20 | a loop in a pipeline cannot create tokens without end |
| Renewal | none | ask for a new lease: the old one is revoked on its own schedule |

- **The value is returned once** and never stored. What is kept is who asked, the provider, the expiry, and a **handle** (a token id, never a credential), in the open, like a rotation's handle: an id has nothing to unseal. This replaces the task text's "sealed revoke handle".
- **Native expiry is the backstop.** GitLab expires a token at midnight UTC of a date, so a lease is made with the date after its own expiry and never dies early. If the sweeper is down, the token is valid at most until that midnight, up to 24 hours past the lease. The sweeper (the `lease.sweep` job, every minute, independent of the rotation schedule) revokes it on time and marks it; a provider error leaves the lease for the next run.
- **A lease is issued only to a principal that may ask**, for a connection of the principal's own organization, and every issue and revoke is audited with names and ids, never a value.

## Consequences
- Compromise of the database and the master keys yields what it did before this feature: the connections' credentials. Nothing is added by rotation or leases.
- A bot user's `api` token can do more than rotate: GitLab has no narrower scope for it. The bot user's role is the real limit.
- Anyone who may issue a lease can make a GitLab token with the connection's authority, so a lease is narrowed in the platform and not left to the request: **read-only scopes** (`read_api`, `read_repository`, `read_registry`, at least one), **Reporter** access, and the GitLab project taken from the platform project's own link, never from the request. A lease for more is a change to this ADR.
- A lease sweeper that cannot reach GitLab leaves a token valid until its native expiry (above); that is a stated limit, not a bug to be fixed in the sweeper.
- Not covered: a provider for a database or cloud IAM (item 3), renewal, an organization-set TTL cap.
