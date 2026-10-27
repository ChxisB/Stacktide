# 35 Resource catalog - Spec
Prefix: BLP · Milestone: M5 · Status: go given 2026-10-23 on the recommended answers; BLP-1 (ADR-0024 / D19, **Proposed**) and BLP-2 (`docs/blueprints-spike.md`) done, build in progress · Needs: 09, 16, 25 · Came from: "I want a powerful tool like Coolify, Space Cloud, Dokploy to easily manage resources and deploy new ones in an all in one platform", "deploy to GCP or AWS", "work with GitHub or GitLab" (2026-10-23)

## Goal
Add a **resource** to an environment from a short list (a network, a container service, a Postgres, a bucket) on **AWS or GCP**, from the CLI or the page, and get a reviewed **merge request (GitLab) or pull request (GitHub)** holding the Terraform for it. Applying it is the flow the platform already has: plan, policy, cost, approval, apply, drift.

This is the first of three features that make the platform an all-in-one place to run an app: **35** what you can create, **36** how an app gets onto it, **37** one screen that shows and manages it all. Features 33 (runners) and 34 (whole environments) sit beside them.

**Is it Coolify?** Not the same machine, and on purpose. Coolify and Dokploy install on a server and run your apps in Docker on it ("You only need an SSH connection", Coolify's README), so they hold access to your servers. This platform holds no cloud or server credential (D1, invariant 3). What we keep from them is the **shape of the product**: apps, databases, domains, variables, previews, rollback, one place to see it. What differs: a resource here is a **managed cloud service in your own account** (Cloud Run, Cloud SQL, S3), every change is a reviewed MR or PR, and the credential stays on the CI runner.

## What I read (2026-10-23)
Only the READMEs. Nothing was installed or run.

| Source | Result | Taken / not taken |
|---|---|---|
| [Coolify](https://github.com/coollabsio/coolify) | Apache-2.0. Needs only SSH to a server. Applications, managed databases, "more than 360 one-click services". Builds from Nixpacks, Railpack, Dockerfile, Compose or a prebuilt image. Pull-request previews, database and storage backups, custom domains with automatic HTTPS, multi-server, GitHub/GitLab/Bitbucket/Gitea, rollback to retained images, health checks, logs, API, CLI and MCP. **AWS and GCP: not stated** | Taken: the product shape. Not taken: SSH and a Docker runtime, build packs, 360 services |
| [Dokploy](https://github.com/dokploy/dokploy) | "Free, self-hostable PaaS". The page names `LICENSE.MD` and `LICENSE_PROPRIETARY.md` and does not say which terms apply, so **ideas only**. Docker Swarm and Traefik; applications, databases (MySQL, Postgres, MongoDB, MariaDB, libsql, Redis), Compose, one-click templates; database backups to external storage; monitoring; multi-node and multi-server; CLI and API. Git providers and previews: **not stated** | Taken: resource kinds and templates as a catalog. Not taken: the runtime |
| [Space Cloud](https://github.com/spacecloud-io/space-cloud) | Apache-2.0, "Kubernetes based serverless platform", instant realtime APIs over MongoDB, Postgres, MySQL and SQL Server, S3/GCS file stores. **The README says it is in maintenance mode and points to Hasura or Wundergraph** | Nothing. A backend-as-a-service on Kubernetes, and unmaintained: not a base and not a goal |
| Cloud Run, ECS Fargate, App Runner, Cloud SQL, RDS, Workload Identity Federation, IAM OIDC providers | **Not read.** Prior knowledge only. Whether AWS App Runner still takes new accounts is unknown to me | BLP-2 verifies each before a module is written |

## Scope
A) A decision (ADR-0024) and a spike. B) Typed inputs and eight small Terraform modules. C) A renderer and a route that proposes the files. D) Records, public outputs, safe defaults, CLI. E) Docs, demo, a real apply.

## Non-goals
- **Running anything ourselves**: SSH, a VM, Docker, Swarm, Traefik. No server access is held.
- Kubernetes clusters (GKE, EKS) as a blueprint, a one-click catalog of 360 apps, build packs (the team's Dockerfile builds; Nixpacks is backlog), backend-as-a-service, Azure.
- **Deleting a resource.** Removing is feature 34's destroy run and a removal MR; delete is opt-in there.
- Any secret in an input, an output, a record or a proposal. The closed schema has no free-text secret field.
- **An existing network, by id.** A service or a database uses a `network` resource of the same environment (found by name, so no remote state); a VPC or VPC network that was made some other way cannot be named. Cut on 2026-10-23 while writing BLP-6..11: it needs a free-text id in the schema and a data lookup the platform cannot check. Backlog: an `existing` network kind that only reads one.

## Design
**A blueprint is (kind, cloud).** Kinds in the first cut: `network`, `service`, `postgres`, `bucket`, each for `gcp` and `aws` (eight modules). A service needs a network and a database needs one, on both clouds; the network may instead be an existing one named by id.

| Kind | GCP | AWS |
|---|---|---|
| `network` | VPC, subnet, direct VPC egress for Cloud Run | VPC, subnets, NAT |
| `service` | Cloud Run service from an image, a service account, an Artifact Registry repository for its images | ECS Fargate behind an ALB (question 2), a task role, an ECR repository for its images |
| `postgres` | Cloud SQL, private IP, backups, deletion protection | RDS, private subnets, backups, deletion protection |
| `bucket` | GCS, uniform access, public access prevented | S3, public access blocked, encryption |

**Inputs are a closed schema** (zod, strict): `name` and `environment` (slug charset), `region` pattern, `profile` (`small|medium|large`, a reviewed table to machine, instance or CPU/memory size per cloud), booleans, small integers, `uses`. Values reach HCL only through that schema, as escaped literals: the same injection defence and test as ELR-7 (quotes, newlines, `${`, `%{`, backslash in every field). A stored resource is always one the renderer accepts.

**Safe defaults, not options:** databases private with deletion protection and backups on; buckets private and encrypted; services take no unauthenticated traffic unless `public: true`. A test renders each blueprint and plans it against the shipped policy set.

**Rendered stack** (a directory `<path>/<environment>/<name>-<kind>/`: a database and a bucket may both be called `main`, and the stack name `<environment>-<name>-<kind>` is unique because of the kind): `stack.yml` (`tool: terraform`, a pinned version, `name: <environment>-<name>-<kind>` which is also the state key, no `environment:` key (the spike: GitHub refuses it and a blueprint reads no platform variables), `depends_on` from `uses`, `state: gitlab` on GitLab and `state: orch` on GitHub), a `main.tf` that declares `backend "http" {}` (what the platform wires for both; ADR-0017, and `usesPlatformState` in `pipeline-gen.ts`) and calls the module, a README. `state: orch` is already the default for a GitHub stack because GitLab-managed state is refused there (flag `managedState`). The module itself is copied **once per repository** into `<path>/_blueprints/<cloud>/<kind>-<version>/` (the version is `v1`, `v2`, ... and is pinned with a digest of the module files) and referenced by a relative path (question 1), so the diff is reviewable and a later version is a new directory.

**Wiring by name, not by state.** `service.uses = ["postgres:main"]` makes the renderer add `depends_on` and name the secret the database module creates (`<environment>-main-database-url`, in Secret Manager or Secrets Manager); the service's identity is granted access to exactly that secret, and the cloud mounts it. The platform never sees the value. (Remote-state outputs would need a second data path; question 3.)

**Proposed through the forge seam** (`packages/forge`): an MR on GitLab, a PR on GitHub, never a default branch, one branch per resource so a repeat updates the same proposal. Refused with a sentence when the project has no stack pipeline yet (onboarding comes first).

**Records.** Table `resources` (additive): organization, project, environment, kind, cloud, name, inputs (jsonb, no secret by construction), stack path, proposal link. **State is derived** from the stack's state (feature 34's rule), never stored twice. A change to inputs is `PATCH`, which proposes again; the plan shows a replacement and policy can stop it.

**Public outputs.** The apply summary may carry the blueprint's declared outputs only (`url`, `console_url`), each a non-sensitive string of at most 300 characters. This is what feature 37 shows as links. A leak test proves nothing else leaves a summary.

**GitHub and GitLab.** Same route, same files; the differences are the PR or MR, the state backend above, and that GitHub has no cost estimate (feature 16 is refused there, flag in the page).

## Acceptance
- `orch resource add service --cloud gcp --name api --uses postgres:main --env staging` opens one MR with `stack.yml`, `main.tf`, the vendored module and a README; the same call on a GitHub project opens one PR with `state: orch`. A second call changes the same proposal.
- Each of the eight modules passes an opt-in `terraform validate` (skipped when Terraform is absent, and named as skipped) and a plain test that fails on a public bucket, an unprotected database, a service open to the internet by default, or a wildcard IAM role.
- The injection test passes through every field of every kind.
- A service that `uses` a database cannot name another cloud's database, an unknown resource or itself (refused by name).
- A rendered stack parses with the existing stack schema, is picked up by `scan`, and its plan runs through the existing flow (an integration test on both mock forges).
- Not claimed: that any module creates anything in a real cloud. That is BLP-21, a human gate.

## Risks / human gates
- **BLP-1 (ADR-0024)**: shipping Terraform that creates paid infrastructure, and what the platform promises about it. Human gate.
- **BLP-21**: the first real apply of all eight modules in a sandbox AWS and GCP account.
- **The catalog is a maintenance promise.** Eight modules, two providers, provider versions that move. The first cut stays at four kinds on purpose; Coolify's 360 services are the warning.
- **Networking is the hard part of "like Heroku".** A private database reached from a managed service needs a network on both clouds; that is why `network` is a kind.
- **HCL from settings** is an injection surface: `/security-review` on BLP-16.
- **Cost.** Cloud SQL, RDS, NAT gateways and load balancers bill while idle. The README of each module states its idle cost; the estimate (feature 16) shows it on GitLab only.
- **Module drift**: a vendored copy in a repository does not update itself. A new version is a new directory and a proposal; nothing rewrites the old one.

## Open questions (recommended answer first)
1. **How the module reaches the repository.** Vendored once per repo under `_blueprints/` (recommended: reviewable, offline, pinned) or a Git `source` URL to this platform's repository?
2. **AWS service.** ECS Fargate with an ALB (recommended: not at risk of being closed to new accounts; more HCL) or App Runner (simpler). *Settled by BLP-2: App Runner is closed to new customers since 2026-04-30; ECS Fargate it is.*
3. **Wiring.** By deterministic secret and resource names (recommended) or by Terraform remote-state outputs?
4. **First kinds.** `network`, `service`, `postgres`, `bucket` (recommended), or add `redis` and a queue now?
5. **State on GitHub.** The platform's own `state: orch` (recommended; already the default there) or a bucket backend of the team's own, which the platform then does not wire?
6. **Where the files go.** `infra/` in the project's own repository (recommended) or a separate infrastructure project the admin names, as for fleets?
7. **Build packs.** Keep the team's Dockerfile (recommended) or add Nixpacks later as Coolify does?
