# References - what we borrow, and where it lands

Rows marked * were read from the upstream README while planning. The rest are from prior knowledge - re-check upstream docs before copying behaviour.

| Reference | What it is | Borrow | Lands in |
|---|---|---|---|
| [Spacelift](https://spacelift.io/) | Managed IaC CI/CD | Stack as the unit of work; shared "contexts" (vars attached to many stacks); policy-as-code (OPA) at plan/approval/trigger; drift detection; run states + approvals; stack dependencies | IAC, POL, VAR scopes |
| [Terragrunt](https://github.com/gruntwork-io/terragrunt) | Thin Terraform wrapper | DRY config via include/inherit; `dependency` ordering; `run-all` parallel waves; auto remote-state config | IAC-2, IAC-8, PIPE-3 |
| [Terramate](https://github.com/terramate-io/terramate) | Stacks + orchestration | Stack = directory + metadata + tags; git-based change detection (`--changed`); ordered execution; generating CI pipelines | IAC-1..4 (core model) |
| [Atmos](https://github.com/cloudposse/atmos) | Stack config framework | YAML manifests with imports + deep-merge inheritance; component catalog; "describe affected" | PIPE-3 layering, IAC-1 config |
| [Terraspace](https://github.com/boltops-tools/terraspace) | Terraform framework | Convention-over-config layout; env/region layering; before/after hooks; ordered `all up` | PIPE-3 conventions, IAC-4 hooks |
| [Atlantis](https://github.com/runatlantis/atlantis) | PR automation | Autoplan on changed files; `plan`/`apply` as MR comments; apply the *saved* plan; per-dir locks; apply requirements (approved, mergeable); in-repo config | IAC-3, 6, 7 |
| [Stategraph](https://github.com/stategraph/stategraph) * | Graph state + orchestration | Creds stay with the runner (server never runs Terraform); every plan/apply a recorded transaction; resource-level locks; state queryable by SQL; CODEOWNERS approvals, policy and cost gates | D1/D9, IAC trust boundary, backlog |
| [envolve](https://github.com/erdemkosk/envolve) * | Go CLI centralising `.env` files | One canonical store; bulk key search/edit across projects; table view; sync one vs sync-all; encrypted backup | VAR-6, VAR-7, CLI-3 |
| [EnvSync](https://github.com/EnvSync-Cloud/envsync) * | Bun + Hono env/secrets platform | Point-in-time rollback; approval workflow for prod changes; OIDC for CI; audit + log forwarding; many sync targets; `pull/push/export/run` CLI; typed SDKs | VAR-5, AUTH-6, CLI-4/5, GOV, SYNC, EXT |
| [Infisical](https://github.com/Infisical/infisical) | Secrets platform | Project > environment > folder model; secret versioning; references/imports; integrations incl. GitLab; `run` injection; dynamic secrets + rotation; secret scanning; audit | VAR, SYNC, CLI-4, EXT-6, backlog |

## Differentiator to protect
None of the above is "paste a GitLab project URL, get a working pipeline + its variables wired up". Keep onboarding (GL-7 -> PIPE-4 -> PIPE-6 -> SYNC) the shortest path in the product.
