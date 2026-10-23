# 21 DNS Management - Spec
Prefix: DNS · Milestone: M5 · Status: done (planned 2026-10-19, approved 2026-10-20, delivered 2026-10-20)

## Goal
Manage DNS zones as code through the platform: a zone is a stack, a merge request shows exactly which records would be created, changed or deleted, apply pushes them on merge, drift is detected, and the platform refuses the changes that make DNS tools dangerous (a zone nobody claimed, a surprise delete, a broken email setup).

## Answer to "can the platform do this?"
Yes, and without holding a single DNS credential. The five references split into one engine and four lessons:

| Reference | Role here |
|---|---|
| [DNSControl](https://github.com/DNSControl/dnscontrol) | **The engine.** `dnsconfig.js` in git, `preview` / `push`, 76 providers. Runs in the CI runner. |
| [octoDNS](https://github.com/octodns/octodns) | Same idea, YAML. Alternative engine, not built (open question 1). Borrow: refuse plans that change or delete too much. |
| [external-dns](https://github.com/kubernetes-sigs/external-dns) | Kubernetes-side record derivation. **Not rebuilt**; it keeps owning cluster records (coexistence doc). Borrow: `upsert-only` as the default, domain filter, ownership. |
| [gardener external-dns-management](https://github.com/gardener/external-dns-management) | Borrow: a provider may only touch the domains it includes (= our zone claims), name validation. Owner IDs were dropped upstream, so we do not build on them. |
| [dns-orchestrator](https://github.com/AptS-1547/dns-orchestrator) | UI-first manager that calls provider APIs with stored credentials (the opposite of invariant 3). Borrow: the post-change checks (propagation, DNSSEC) as backlog. |

## Scope
- `dnscontrol` as a stack tool: plan on MR (`preview`), apply on merge or command (`push`), same run model, MR note, approvals and drift as Terraform stacks.
- Zone claims: an organization admin says which project and stack may manage which zone.
- Apply gates: unclaimed zone, delete without opt-in, lint error -> denied.
- "Right settings": a small lint (single SPF, DMARC next to MX, CAA, TTL bounds, unmanaged records kept) on top of DNSControl's own `check`.
- Starting a zone safely: `orch dns init` scaffold and a manual import job, so the first plan of an existing zone is empty.
- Provider tokens are ordinary managed variables (VAR), synced to the project and handed to the job by `orch run`; `creds.json` holds `$VAR` references only.

## Non-goals
- The control plane calling any DNS provider or registrar API (no new invariant-3 exception, no new `connections` types). Recorded as the rejected alternative in the ADR.
- A record editor in the UI. Records live in the repo; the UI shows claims and runs.
- octoDNS or other engines; registrar/NS delegation management; DNSSEC key handling.
- Propagation checks after apply, DNS-derived-from-environments (external-dns style sources): backlog.
- Evaluating `dnsconfig.js` in the control plane. Only the runner runs the tool.

## Design
- **Decision (ADR-0018, DNS-1; adds D13 to the ROADMAP once accepted):** DNS is applied runner-side. Same trade as D1: plans and drift need a pipeline round trip, and in return nothing in the platform can rewrite your DNS.
- **Stack**: `stack.yml` gains `tool: dnscontrol`, `version` required (image tag), no `state` (there is no Terraform state; `state:` is refused), and `dns: { prune: false }` (default; `true` allows deletes). Zones come from `dnsconfig.js`, not from `stack.yml`. `stacks_tool_check` is widened by an additive migration.
- **Plan job**: `dnscontrol check` (offline), then `dnscontrol preview`; the preview is an artifact (`access: developer`, it holds record values). The summary job maps it to the **existing** plan-summary shape: `add` / `change` / `destroy` and `resources[] = { address: "<zone>/<name>/<TYPE>", actions: ["create"|"update"|"delete"] }`. No value ever leaves the runner, so the summary route, run model, MR note and drift code (`stack-drift.ts`) take DNS stacks unchanged. Read from `preview --report` JSON, not the console text (DNS-2, `docs/dns-spike.md`).
- **Apply job**: DNSControl has no saved plan. The apply job re-runs `preview` and compares a digest of the change set with the plan job's; a different set ends the job with a fixed "zone changed since the plan, plan again" (the `plan_stale` idea) and nothing is pushed. Otherwise `push`. The per-stack `resource_group` mutex stays.
- **Credentials**: the project's variables for the stack's `environment` reach the tool through `orch run` (prefix chosen in DNS-2); `creds.json` is `{"cf": {"TYPE": "CLOUDFLAREAPI", "apitoken": "$CF_API_TOKEN"}}`. Scoping the token to the zones is the real boundary (as ADR-0013 says of credentials); the docs say how for Cloudflare and Route 53. Rotation (feature 14) applies to the same variables.
- **Zone claims** (`dns_zones`: org, zone, project, stack; zone unique per organization; `/organizations/:orgId/dns/zones`, list needs reporter, write needs org admin, audited `dns_zone.*`). At summary ingest every zone named in `resources` must be claimed by that stack's project and stack. A zone with no changes is not listed and not checked: nothing to harm.
- **Delete gate**: a plan with any `delete` is denied unless the stack has `dns.prune: true` (invariant 5: delete is explicit opt-in; DNSControl purges unknown records by default, which is the opposite of the sync engine's `ignore`). Denied the same way a policy `deny` blocks apply (IAC-8 precondition); read that code before building DNS-7.
- **Lint** (`packages/iac`, pure, `print-ir` JSON in, findings out; no values): severity `error` denies apply, `warn` shows on the MR note. v1 rules: `spf-single` (one SPF record per name, error), `dmarc-with-mx` (a name with MX has `_dmarc`, warn), `caa-apex` (warn), `ttl-range` (60 to 86400, warn), `keep-unknown` (zone purges unmanaged records while `prune` is false, error). The summary gains an optional bounded `lint` block like `cost` did.
- **Start safely**: `orch dns init` writes `stack.yml`, `dnsconfig.js` (unmanaged records kept) and `creds.json` (references only), refuses to overwrite, and prints the variable names to create. A generated manual `import:<stack>` job runs `get-zones`; its artifact is the starting config to commit, so plan 1 is empty.
- **Coexistence with external-dns**: documented, not coded: leave cluster names to external-dns (delegate a subdomain, or ignore those names in `dnsconfig.js`), never both owning one name.

## Invariants check
1 values never in summary, MR note, lint findings, audit or errors (canary TXT test in DNS-4, 7, 11) · 2 no new GitLab or target I/O outside `packages/gitlab`; the platform makes no DNS calls at all · 3 kept whole, no exception · 4 zone routes have guards and audit · 5 plan -> apply, idempotent, preview is the dry run, delete opt-in · 6 nothing pushed to a default branch by the platform · 7 tests use fixtures and DNSControl's local `BIND` provider, never a real zone · 8 migrations additive (widen a check, add a table).

## Acceptance
On a fixture repo with a `dnscontrol` stack and a claimed zone: an MR that adds one record plans with one create and posts one note with counts and addresses (no values); `orch apply` pushes exactly that change set; a second plan is empty; a record changed out of band shows as drift; a plan that deletes a record is denied until `prune: true`; a zone nobody claimed is denied; a zone with two SPF records is denied by lint. A TXT record holding a canary string appears nowhere in the platform's storage, logs or MR note.

## Risks / human gates
- **ADR-0018 (DNS-1)** is a human gate: it adds a decision.
- **The first real `push`** to a real provider and zone is a human gate; do it on a throwaway zone with a zone-scoped token.
- **Assumptions about DNSControl: verified by DNS-2** (2026-10-20, v5.5.0, `BIND` provider, `docs/dns-spike.md`): report JSON and change grammar, `print-ir` and the keep-unknown flag, `$ENV` in `creds.json`, purge default, official image and tag scheme, `orch run` with no prefix. Not verified: a network provider's wording, an unset `$VAR` for one, the image on a CI runner; the first real run is the gate below.
- **Claims are a guard, not a wall**: the repo's own code runs in the job, so the token's zone scope is the boundary. State this in the ADR and docs.
- `/security-review` on DNS-5, DNS-6, DNS-7 (apply path, authz, credentials).

## Open questions (answer at approval)
1. Engine: DNSControl (recommended: more providers, `print-ir`, JS macros) or octoDNS (YAML, easier to generate, fewer providers)?
2. Do you also want the platform to talk to a DNS provider directly (instant plans, UI record editing, no pipeline)? Recommended: not now; it is a second invariant-3 exception and 76 providers are already covered.
3. Which DNS provider(s) and registrar do you use today? Decides the scaffold's default, the docs example and which token-scoping guide to write.
4. Record values in the MR note and summary: names, types and actions only (recommended; the values are in the MR diff and the job) or include values?
