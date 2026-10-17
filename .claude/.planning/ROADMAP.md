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
| D9 | IaC state | GitLab-managed Terraform state (HTTP backend) v1; graph/SQL state is backlog | Stategraph idea deferred |
| D10 | Layout | `apps/{api,cli,web}`, `packages/{core,db,crypto,gitlab,sync,pipelines,iac}`; create packages lazily | |
| D11 | UI | React via Bun HTML imports, no Next.js | Revisit in UI-1 |
| D12 | Lint/format | Biome | |

## Features
Status: `todo` / `building` / `done`. The factory updates this table.

| # | Feature | Prefix | Milestone | Needs | Status |
|---|---|---|---|---|---|
| 00 | [foundation](00-foundation/) | FND | M0 | - | building |
| 01 | [core-api-and-db](01-core-api-and-db/) | API | M1 | 00 | building |
| 02 | [auth-and-rbac](02-auth-and-rbac/) | AUTH | M1 | 01, 03 | todo |
| 03 | [gitlab-integration](03-gitlab-integration/) | GL | M1 | 01, VAR-1 (GL-6 only) | building |
| 04 | [secrets-and-variables](04-secrets-and-variables/) | VAR | M1 | 01, 02 | todo |
| 05 | [sync-engine](05-sync-engine/) | SYNC | M1 | 03, 04 | todo |
| 06 | [pipeline-catalog](06-pipeline-catalog/) | PIPE | M2 | 03, 04 | todo |
| 07 | [cli](07-cli/) | CLI | M2 | 02, 04 | todo |
| 08 | [web-ui](08-web-ui/) | UI | M2 | 04, 05, 06 | todo |
| 09 | [iac-stacks-and-runs](09-iac-stacks-and-runs/) | IAC | M3 | 02, 03, 04, 07 | todo |
| 10 | [drift-and-policy](10-drift-and-policy/) | POL | M4 | 09 | todo |
| 11 | [governance](11-governance/) | GOV | M4 | 01, 04, 05 | todo |
| 12 | [extra-sync-targets](12-extra-sync-targets/) | EXT | M5 | 05 | todo |
| 13 | [deploy-and-operate](13-deploy-and-operate/) | OPS | M2-M4 | 01 | todo |

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

## Backlog (deliberately not broken down yet)
Break these down with `plan` when they become next.
- Secret rotation and dynamic (short-lived) secrets - Infisical, EnvSync.
- Graph/SQL state backend, resource-level locks, scoped plans - Stategraph.
- Own worker pools / runner-side agent (Spacelift private workers).
- `include`/CI-component render mode and a public template registry.
- Secret scanning of repos; cost estimation gates.
- SAML/SSO beyond GitLab OAuth; multi-org tenancy UI.
