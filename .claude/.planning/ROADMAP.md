# DevOps Orchastrature - Roadmap

A control plane to **set up CI/CD for GitLab projects in minutes, manage variables/secrets in one place, and sync them where they need to go** - later extended to IaC stack orchestration. Inspiration and what we borrow: [REFERENCES.md](REFERENCES.md). How we build: `.claude/skills/software-factory/SKILL.md`.

## Architecture in one breath
Bun + TS monorepo. API + worker (same codebase, two entrypoints) over Postgres. **GitLab is the runner**: the platform generates pipeline config, opens MRs, triggers pipelines, receives webhooks, stores desired state (variables, stacks) and records runs. Secrets are envelope-encrypted at rest. Humans sign in with GitLab; CI jobs authenticate with GitLab OIDC `id_tokens`. Clients: CLI (`orch`) and web UI share one typed API client.

## Decisions (confirmed 2026-10-17 in FND-1 - ADRs in `docs/adr/`)
| # | Topic | Decision | Why / alternative |
|---|---|---|---|
| D1 | Execution model | GitLab CI is the runner; platform is control plane | No runner fleet to build; cloud creds stay runner-side (Stategraph). Alt: own workers (Spacelift) |
| D2 | Runtime | Bun, TypeScript strict | Given |
| D3 | API framework | Elysia (typed client via Eden) | Alt: Hono (EnvSync) + generated SDK |
| D4 | Database | Postgres + Drizzle on `Bun.sql` | One infra dependency; verify driver in API-1 |
| D5 | Job queue | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED` | No Redis. Upgrade when throughput needs it |
| D6 | Auth | GitLab OAuth (humans), scoped API tokens, GitLab OIDC for CI | Team already lives in GitLab |
| D7 | Secrets at rest | AES-256-GCM envelope, per-project DEK, `KeyProvider` (env key now, KMS later) | |
| D8 | Pipeline delivery | Render template inline into `.gitlab-ci.yml` via MR (v1); `include`/components mode later | No extra templates repo needed |
| D9 | IaC state | GitLab-managed Terraform state (HTTP backend) is the default; **platform-hosted state is an opt-in per stack (`state: orch`), ADR-0017 (2026-10-19)**. Graph and resource-level locks stay backlog | Stategraph idea: storage, versions, locks and an index only |
| D10 | Layout | `apps/{api,cli,web}`, `packages/{core,db,crypto,gitlab,sync,pipelines,iac}`; create packages lazily | |
| D11 | UI | React via Bun HTML imports, no Next.js | Revisit in UI-1 |
| D12 | Lint/format | Biome | |

## Features
Status: `todo` / `building` / `done`. The factory updates this table.

| # | Feature | Prefix | Milestone | Needs | Status |
|---|---|---|---|---|---|
| 00 | [foundation](00-foundation/) | FND | M0 | - | building |
| 01 | [core-api-and-db](01-core-api-and-db/) | API | M1 | 00 | done |
| 02 | [auth-and-rbac](02-auth-and-rbac/) | AUTH | M1 | 01, 03 | done |
| 03 | [gitlab-integration](03-gitlab-integration/) | GL | M1 | 01, VAR-1 (GL-6 only) | done |
| 04 | [secrets-and-variables](04-secrets-and-variables/) | VAR | M1 | 01, 02 | done |
| 05 | [sync-engine](05-sync-engine/) | SYNC | M1 | 03, 04 | done |
| 06 | [pipeline-catalog](06-pipeline-catalog/) | PIPE | M2 | 03, 04 | done |
| 07 | [cli](07-cli/) | CLI | M2 | 02, 04 | building (CLI-7 awaits a real tag pipeline) |
| 08 | [web-ui](08-web-ui/) | UI | M2 | 04, 05, 06 | done (UI-9's e2e is green on GitHub Actions; it has not run on a real GitLab, FND-6) |
| 09 | [iac-stacks-and-runs](09-iac-stacks-and-runs/) | IAC | M3 | 02, 03, 04, 07 | done (first real plan/apply is a human gate) |
| 10 | [drift-and-policy](10-drift-and-policy/) | POL | M4 | 09 | done (first real drift check, policy evaluation and notification are human gates) |
| 11 | [governance](11-governance/) | GOV | M4 | 01, 04, 05 | done (first real approval, gated apply and forwarding are human gates) |
| 12 | [extra-sync-targets](12-extra-sync-targets/) | EXT | M5 | 05 | done (first real sync to AWS and Kubernetes, and ADR-0013's acceptance, are human gates) |
| 13 | [deploy-and-operate](13-deploy-and-operate/) | OPS | M2-M4 | 01 | partial (OPS-1/3/4/5 done; OPS-2/6/7 blocked: a real GitLab OAuth app and pipeline, publishing is a human gate) |
| 14 | [secret-rotation](14-secret-rotation/) | ROT | M5 | 04, 05, 11 | done (first real rotation and first real lease against GitLab are human gates) |
| 15 | [component-mode-and-registry](15-component-mode-and-registry/) | CMP | M5 | 06 | done (first real Catalog publish and first real component MR are human gates) |
| 16 | [cost-gates](16-cost-gates/) | COST | M5 | 09, 10 | done (first real estimate and first real blocked apply are human gates) |
| 17 | [secret-scanning](17-secret-scanning/) | SCAN | M5 | 06, 10 | done (first real secret-detection report read from GitLab and first real blocked apply are human gates) |
| 18 | [graph-sql-state](18-graph-sql-state/) | STATE | M5 | 09, 13 | done (ADR-0017 accepted on the standing authorization; changes D9) |
| 19 | [worker-pools](19-worker-pools/) | POOL | M5 | 09, 10 | done (a real runner and GitLab runner listing are human gates; ADR-0015: tags only, no agent) |
| 20 | [sso-and-multi-org](20-sso-and-multi-org/) | SSO | M5 | 02 | done (the first real provider sign-in is a human gate; ADR-0016: OIDC only; open: provider-scoped sessions, and how an SSO-only organization gets its first owner) |

### Milestones
- **M0 Foundation** - green empty monorepo, ADRs confirmed.
- **M1 Variables to GitLab (API only)** - connect GitLab, import projects, manage variables per environment, plan/apply sync to GitLab CI variables. First real value.
- **M2 Pipelines, CLI, UI** - one-click pipeline setup via MR, `orch pull|run|push`, dashboard. The "super easy" milestone. Containerise (OPS-1, OPS-2) here.
- **M3 IaC** - stacks, change detection, plan on MR, apply on merge/command.
- **M4 Governance** - approvals, audit export, drift, policy, hardening.
- **M5 Expansion** - AWS SSM / Secrets Manager / Kubernetes / Vault targets.

### Suggested build order for M0-M1
FND-1..6 -> API-1..3 -> GL-1..5 -> VAR-1 -> API-4..8 -> AUTH-1..4 -> GL-6..8 -> VAR-2..4 -> SYNC-1..5 -> rest of 04/05.
Cross-feature deps are listed per task, so the factory's `next` follows them automatically.

**Release gate:** do not expose the API beyond localhost until AUTH-3, AUTH-4 and OPS-5 are `[x]`.

## Suggested order for features 14-20
Cheapest and least risky first: **15 -> 16 -> 14 -> 17 -> 19 -> 20 -> 18**. Features 18 and 20 start with an ADR that changes a confirmed decision (D9, ADR-0006), so they wait for your go. 19's agent question is POOL-7.

## Backlog (deliberately not broken down yet)
Planned as features 14-20 on 2026-10-19; what is left out of them:
- Resource-level locks and scoped plans (Stategraph) - spike STATE-9 decides.
- A platform-shipped pull-based worker agent (Spacelift private workers) - POOL-7 decides.
- A self-hosted public template registry (the GitLab CI/CD Catalog is the registry in feature 15).
- Rotation providers that need long-lived admin credentials (Postgres role, AWS IAM) - ROT-9 decides.
- SCIM provisioning; matching scan findings against managed variable values.
