# ADR-0024: Blueprints are shipped Terraform, rendered from values, and proposed as a merge or pull request
Status: **Proposed** (the recommended answers to the SPEC's seven open questions, taken on your "Go" of 2026-10-23 after the plan for features 33 to 37. Feature 35's tasks are built on it, so a reversal costs rework; **accept, amend or reverse it here**. Not accepted by anyone yet) · Roadmap: BLP-1, adds D19 · Builds on: ADR-0001 (D1), ADR-0017 (platform state), ADR-0019 (forge seam) · Numbering: D17 and D18 are reserved for ADR-0022 (runners) and ADR-0023 (environments), which are not written yet

## Context
The platform plans and applies the infrastructure stacks a team already has (`stack.yml` plus Terraform). It cannot yet create one: a team that wants "a service, a Postgres and a bucket on AWS or GCP" writes the Terraform by hand. Coolify and Dokploy answer that with a catalog of resources, but they install on a server and hold SSH access to it. Invariant 3 and D1 say the control plane holds no cloud or server credential; the forge's CI runner does, through OIDC.

## Decision
1. **A resource is a managed cloud service, described by a blueprint `(kind, cloud)`.** First cut: `network`, `service`, `postgres`, `bucket`, each for `gcp` and `aws` (eight modules). No server, no Docker runtime, no Kubernetes, no Azure.
2. **The module is shipped Terraform; the only input is a closed schema.** The platform renders `stack.yml`, a `main.tf` that calls the module with escaped literals, and a README. Values reach HCL only through a strict zod schema (charsets for names, region patterns, a `profile` of `small|medium|large`, booleans, small integers, `uses`). No free-text field, no secret field. A stored resource is always one the renderer accepts.
3. **The module is vendored once per repository** under `<path>/_blueprints/<cloud>/<kind>-<version>/` and referenced by a relative path. A later version is a new directory and a new proposal; nothing rewrites an old one.
4. **Creation is a proposal, never a call.** The platform opens one merge request (GitLab) or pull request (GitHub) through the forge seam, one branch per resource, never a default branch. Applying it is the flow that exists: plan, policy, cost estimate where the forge has one, approval, apply, drift. The platform makes no cloud call.
5. **State is the platform's own on both forges' defaults.** The rendered `main.tf` declares `backend "http" {}`; `stack.yml` says `state: gitlab` on GitLab and `state: orch` on GitHub (the default there, since GitLab-managed state is refused).
6. **Wiring is by name.** `uses: ["postgres:main"]` becomes `depends_on` and a deterministic secret name (`<environment>-<name>-database-url`); the service's identity is granted exactly that secret. The platform never sees the value and no Terraform remote-state read is added.
7. **Safe defaults, not options.** Databases are private with deletion protection and backups; buckets are private and encrypted; services take no unauthenticated traffic unless `public: true`; no wildcard role. A test renders each blueprint and runs it through the shipped policy pack.
8. **Public outputs are an allowlist.** The apply summary may carry a blueprint's declared `url` and `console_url`, non-sensitive strings of at most 300 characters. Nothing else leaves a summary.
9. **Records.** An additive `resources` table (inputs, stack path, proposal link). A resource's state is derived from its stack's state, never stored twice.
10. **D1 and invariant 3 do not change.** The credential stays on the runner.

## Why this, and what was left out
- **(b) Modules by Git URL** to this platform's repository was rejected: a plan would depend on a network fetch and a moving ref, and a diff would not show what is deployed.
- **(c) The platform calls the clouds** was rejected: it breaks invariant 3 and gives up review, policy and drift for free.
- **(d) Install Coolify or Dokploy beside it** was rejected: they hold server access, which is the thing this platform does not do. Dokploy's licence terms are also unclear in its README.
- **Space Cloud** is a Kubernetes backend-as-a-service in maintenance mode; not a base.
- **Remote-state outputs for wiring** were rejected for now: a second data path between stacks and a read right the runner would need.
- **AWS App Runner** was left for BLP-2 to check; ECS Fargate behind an ALB is the recommended service.
- **Nixpacks and other build packs** were left out: the team's Dockerfile builds (feature 36).

## Consequences
- **Eight modules and two providers are a maintenance promise.** Provider versions move; the first cut stays at four kinds on purpose.
- **Networking is the hard part of "like Heroku".** A private database reached from a managed service needs a network on both clouds, so `network` is a kind.
- **Cloud SQL, RDS, NAT gateways and load balancers bill while idle.** Each module's README says what; the estimate shows it only where the forge has estimates (GitLab).
- **HCL built from settings is an injection surface.** One test pushes quotes, newlines, `${`, `%{` and backslashes through every field of every kind; `/security-review` runs on the propose route.
- **Nothing here has created anything in a real cloud.** The modules have met `terraform validate` at most. The first real apply (BLP-21) is a human gate.
- **A vendored copy does not update itself.** That is the price of a reviewable, offline, pinned module.
