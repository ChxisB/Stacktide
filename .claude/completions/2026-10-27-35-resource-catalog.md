# 35 resource catalog - built 2026-10-23 to 2026-10-27 (ADR-0024 and D19 still Proposed; nothing applied in a real cloud)

A project can now **add a network, a container service, a Postgres or a bucket on GCP or AWS** and get one reviewed merge request or pull request holding vetted Terraform. The platform renders values only (a closed, typed input schema is the one way a value reaches HCL), vendors each shipped module once per repository, and never holds a cloud credential: your CI applies it through OIDC, as it applies any stack. Wiring is by name (`uses`), so the platform never sees a connection string or a password.

Everything was built on the recommended answers in the SPEC, under your go of 2026-10-27 to finish features 33 to 37. **ADR-0024 is written as Proposed and is not accepted by anyone**; D19 is in the ROADMAP table as a decision to accept or change. Nothing is committed.

## What was built
- **A, decision and spike (BLP-1, 2).** `docs/adr/0024-blueprints.md` (Proposed); `docs/blueprints-spike.md` (the provider facts read from the registry and docs, each verified or marked unverified).
- **B, schema and eight modules (BLP-3..11).** `BlueprintSchema` (strict, one shape per kind, region and name patterns, profile table `small|medium|large` per cloud, `uses` rules) in `packages/core/src/blueprints.ts`; modules in `packages/iac/blueprints/{gcp,aws}/{network,service,postgres,bucket}/`, each with a README (including an idle-cost line), pinned by version and sha256 in `BLUEPRINT_MODULES`.
- **C, render and propose (BLP-12..16).** `renderBlueprint` (pure: `stack.yml`, `main.tf`, README, vendored module; `state` is `gitlab` on GitLab and `orch` on GitHub); wiring checks (`checkBlueprintWiring`: unknown, other cloud, itself, cycles, service and database on different networks); the `resources` table (migration 0067) and the state derived from the stack's runs; `GET /blueprints`, `GET …/resources`, `GET …/resources/:id`; `POST …/resources` and `PATCH …/resources/:id`, which open one MR or PR on one branch per resource (`orch/resource-<stack>`) and never touch a default branch.
- **D, outputs, defaults, CLI (BLP-17..19).** The public outputs `url` and `console_url` (non-sensitive, at most 300 characters, http or https) travel in the apply summary and are stored on the resource (migration 0068); `blueprint-defaults.test.ts`; `orch resource blueprints|ls|show|add|change` with `--dry-run` through a new read-only route `POST …/resources/preview` that runs the same check as a real proposal.
- **E, docs and demo (BLP-20).** `docs/resource-catalog.md`; four staging resources in the demo seed.
- **Not built, on purpose:** BLP-21 (the first real apply), a human gate.
- **Migrations:** 0067 and 0068, both additive. **New dependencies:** none. **New route count:** the 401-route pin is 189 and the spec pin 185 operations; `docs/openapi.json` is regenerated.

## Existing tests that changed (each is in LOG.md; none skipped or deleted)
- The route-count pins in `authz.test.ts` and `spec.test.ts` rose with the new routes.
- The demo seed test pins the four new resources.
- Nothing was loosened to get green.

## Gate, stated plainly
After the last code change:
- `bun run typecheck` exit 0. `bunx biome check apps packages` exit 0, with the one existing info in `apps/api/src/limits.test.ts:170`.
- **Root `bun test --env-file=.env.example` did not exit 0:** 7025 pass, 13 skip, **4 fail**. All four are `worker entrypoint` tests in `apps/api/src/worker-main.test.ts` that start a child process and wait a fixed 500 ms; the file is not modified, and **run alone it passes 12 of 12**. The earlier full run (7029 pass, 0 fail) did not show them. I did not change the tests.
- **Web:** the last full run was 1131 pass, **1 fail**: `projects.test.tsx` "is not shown from one answer…" (a 5 s wait under load; it passes alone; already noted in BLP-15). Not fixed.
- `bun run e2e` and the demo scans were **not run**: this feature adds no screen.
- **Never applied.** `terraform validate` of all eight modules passed where `ORCH_E2E_TERRAFORM=1` was set during BLP-4..11, not in every later run.

## Reviews
- `/code-review` (medium) on the CLI and the preview route (BLP-19): two fixed, five listed in LOG.md as accepted or follow-ups. Earlier tasks carry their own "security read" in LOG.md. `/security-review` ran for BLP-16 as the task required.

## Not checked
- Any apply, plan or destroy on a real cloud. The Cloud SQL private address needs the network stack's service networking applied first; the order is `depends_on`, rendered and untested against a real project. Whether Cloud Run accepts `INGRESS_TRAFFIC_INTERNAL_ONLY` with direct VPC egress is documented behaviour, not tried.
- The idle costs are the READMEs' own figures for us-east-1 and rough GCP prices, not a bill.
- A real GitLab or GitHub receiving the MR or PR (the mocks were written from the documentation).

## Left out, on purpose
`redis`, queues, a CDN, a domain or certificate resource tied to feature 21, Nixpacks, GKE and EKS, Azure, one-click templates, the resources page (feature 37).

## Follow-ups for your decision
1. **Accept or change ADR-0024 / D19.** Features 34, 36 and 37 are built on it.
2. **Four known `shortcut:` limits** (see `/ponytail-debt`): `--uses` replaces the list and cannot empty it; a repeat `add` with other inputs keeps the title "Add …"; `in_place` returns before it looks at an open request, so a stale open request survives a revert; the forge file lookups run one at a time.
3. **The two flaky tests** (`worker-main.test.ts`, `projects.test.tsx`): raise the waits or split what they build; they are yours to decide.
4. **BLP-21.** To run it, give me a sandbox GCP project and AWS account and say so.
