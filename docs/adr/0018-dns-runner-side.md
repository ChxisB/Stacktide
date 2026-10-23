# ADR-0018: DNS is applied runner-side, with DNSControl
Status: Accepted (the recommended answers to the SPEC's open questions, taken on your instruction to build feature 21; amend or reverse them here) · Roadmap: DNS-1, adds D13 · Builds on: ADR-0001 (D1), ADR-0013, ADR-0017

## Context
Feature 21 manages DNS zones as code: a merge request shows which records would be created, changed or deleted, and apply pushes them. A DNS provider's API token can rewrite every record in a zone, which makes it one of the most dangerous credentials an organization holds. Invariant 3 says the control plane holds no cloud or infrastructure credentials and the CI runner does. ADR-0013 made one designed exception to that for variable sync targets (AWS, Kubernetes, Vault) and said any further one needs its own ADR.

## Decision
1. **DNSControl is the engine, and it runs in the CI runner.** `dnsconfig.js` lives in the repository. A plan job runs `dnscontrol check` and `dnscontrol preview`; an apply job runs `dnscontrol push`. The platform never evaluates `dnsconfig.js` and never calls a DNS provider or registrar.
2. **A zone is a stack.** `stack.yml` gains `tool: dnscontrol` with a required `version` (the image tag), no `state` (there is no Terraform state; `state:` is refused) and `dns: { prune: false }`. Plans, runs, the merge request note, approvals and drift reuse what Terraform stacks already have, because the plan job maps DNSControl's preview to the existing plan-summary shape (counts and `<zone>/<name>/<TYPE>` addresses with actions, never a value).
3. **Provider tokens are ordinary managed variables.** They are stored, versioned, rotated (feature 14) and synced to the project like any other secret, and reach the tool through `orch run`. `creds.json` holds `$VAR` references only.
4. **Claims are a guard.** An organization admin claims a zone for a project and a stack. A plan that names a zone nobody claimed for that stack is denied before apply, the way a policy `deny` is.
5. **Delete is explicit opt-in** (invariant 5). A plan with any delete is denied unless the stack says `dns.prune: true`. DNSControl purges records it does not know by default, which is the opposite of the sync engine's `ignore`, so the scaffold writes a config that keeps unmanaged records and a lint rule errors when a zone purges while `prune` is false.
6. **Plan values stay in the runner.** The preview is a job artifact readable by developers (it holds record values); the summary posted to the platform, the merge request note, lint findings, audit rows and errors carry names, types and actions only.

## Why this, and what was left out
- **The control plane calling DNS providers** (a native adapter per provider through `connections`, as ADR-0013 does for AWS) would give instant plans and a record editor in the UI. It was rejected as a second invariant-3 exception, with a long-lived zone-writing token sealed in our database, and because 76 providers are already covered by DNSControl.
- **octoDNS** (YAML, simpler to generate, fewer providers) is the closest alternative. DNSControl was chosen for its provider count, its machine-readable intermediate form (`print-ir`) and its JavaScript macros. The stack tool name is a field, so another engine is a later task, not a rewrite.
- **Rebuilding external-dns** (Kubernetes sources to records) was not attempted. It keeps owning cluster records; the rule is that two systems never own one name (docs/dns.md says how to split a zone).
- **UI record editor, propagation checks, DNSSEC keys, registrar delegation**: not built; they would need either held credentials or a poll the platform does not do.

## Consequences
- A plan, and drift detection, need a pipeline round trip. There is no instant preview in the UI.
- The platform cannot rewrite your DNS, because it holds nothing that can. Anyone who can change `dnsconfig.js` on a protected branch and run the apply job can, so the boundary is the same one that guards the repository and the job.
- **Claims are a guard, not a wall.** The repository's own code runs in the apply job with the token in its environment, so a hostile `dnsconfig.js` can write any zone the token can write. The real boundary is the token's scope: create it for the zones the stack manages, and nothing else. docs/dns.md shows how for Cloudflare and Route 53, which are the examples because no provider was named.
- DNSControl has no saved plan. The apply job re-runs `preview` and compares a digest of the change set with the plan job's; a different set stops with a fixed message and pushes nothing.
- Several facts about DNSControl (the preview format and exit codes, `print-ir`, `$ENV` references in `creds.json`, the purge default, the `BIND` provider, the official image and its tags) came from prior knowledge, not the README. DNS-2 verifies each before anything depends on it.
- The first real `push` to a real provider is a human gate; do it on a throwaway zone with a zone-scoped token.
