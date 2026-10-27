# 33 Elastic Runners - Tasks

Cuts: A (ELR-1..4, no cloud, no UI), B (ELR-5..8, the fleet as a stack), C (ELR-9..12, lighter pipelines, GitLab, usable without B), D (ELR-13..16, surfaces), E (ELR-18..22, GitHub fleets with GARM). ELR-17 (GitLab) and ELR-23 (GitHub) are human gates. Cuts A to D do not wait for E.

### ELR-1 - ADR-0022: runner fleets are stacks, scaling is GitLab's  `[ ]` S - deps: POOL-7
Do: write the ADR. Options: (a) GitLab's autoscaler, its infrastructure a stack the org's CI applies (recommended); (b) a platform provisioner with cloud adapters (holds credentials, second execution path); (c) the Kubernetes executor. Add the GitHub option: (d) GARM on a VM (recommended), (e) ARC on a cluster (backlog). State what it amends in ADR-0015 (the "provisioning or autoscaling runners" non-goal) and **in ADR-0019 item 8 (worker pools are allowed on GitHub; every other refusal stays)**, and that D1 and invariant 3 do not change. **Human gate; no code.**
Done when: you accept or change it. D17 is added to the ROADMAP only after that.

### ELR-2 - Fleet schema and profile tables  `[ ]` S - deps: ELR-1
Do: `FleetSchema` in `packages/core` (zod, strict: unknown keys refused) with the keys and defaults in the SPEC; the profile to machine type table for AWS and GCP (including `arm64`); the refusals (`dind` with `max_use_count` above 1, ranges, region and zone patterns, one zone).
Done when: `fleet.test.ts` covers each default, each refusal, and every string field against quotes, newlines, `${`, `%{` and backslashes.

### ELR-3 - Store a fleet on a pool  `[ ]` M - deps: ELR-2, POOL-1
Do: additive migration `worker_pools.fleet` (nullable jsonb, CHECK it is an object); `POST` and `PATCH …/pools` accept `fleet` (`null` clears it); `pool.create`/`pool.update` audit the old and new fleet; a pool without one is untouched. Regenerate OpenAPI.
Done when: route tests for create, change, clear, and 422 naming the key; the guard-coverage test is green; the existing pool tests are unchanged.

### ELR-4 - Spike: verify the autoscaler facts we have not read  `[ ]` S - deps: ELR-1
Do: read-only. From GitLab's docs and the Terraform registry, settle each unread item in the SPEC: `[runners.autoscaler]` keys and `instance_ready_command`, policy `periods`/`timezone`/`scale_factor`, `[runners.cache]` for S3 and GCS, the `gitlab_user_runner` resource and the `create_runner` scope, and whether GRIT's GCP modules cover `docker-autoscaler` with `max_use_count`. For GitHub, also from GARM's docs: its AWS and GCP provider executables, how it authenticates to GitHub (App or token, which rights), the `workflow_job` webhook and whether it needs an inbound endpoint, and from GitHub's docs whether `runs-on` can come from matrix data. Write `docs/runner-fleets-spike.md` (as `docs/dns-spike.md` did): each item verified with a link, or still unverified.
Done when: the doc exists and ELR-5/6 and question 1 can cite it. Nothing is installed or run.

### ELR-5 - AWS fleet module  `[ ]` M - deps: ELR-2, ELR-4
Do: `packages/iac/fleet/aws/` Terraform: the group, launch template, manager, roles, cache bucket, secret and runner as in the SPEC; the manager's `config.toml` rendered by `templatefile`; scaling policy `none`, scale-in protection, `AZRebalance` off.
Done when: an opt-in test runs `terraform validate` (skipped without Terraform, named as skipped); a plain test reads the files and fails if the instance profile gets any action, if the manager's role allows more than its own group, or if the group has a scaling policy.

### ELR-6 - GCP fleet module  `[ ]` M - deps: ELR-2, ELR-4
Do: `packages/iac/fleet/gcp/`: the instance group at size 0 in one zone, template, service account with no roles for instances, manager VM, bucket, secret, runner.
Done when: the same two tests as ELR-5; one zone only.

### ELR-7 - Render a fleet as a stack  `[ ]` M - deps: ELR-5, ELR-6
Do: `renderFleet(pool): { path, content }[]`: `stack.yml` (`tool: terraform`, a `version`, the pool's own name), a `main.tf` calling the module with the fleet's values as HCL literals, a README of what applying creates and costs. Pure; values come only from the schema.
Done when: snapshots for AWS and GCP and each profile; the injection test from ELR-2 run through the renderer; the rendered `stack.yml` parses with the existing stack schema and `scan`.

### ELR-8 - Propose the fleet as a merge request  `[ ]` M - deps: ELR-7, ELR-3
Do: `POST /organizations/:orgId/pools/:poolId/fleet/propose` `{connectionId, projectId, path}` (organization admin, deny by default, audited as `pool.fleet_propose` with the file list, no content): opens an MR through the delivery code the pipeline onboarding uses (the GitHub pull request is ELR-22); same branch name each time; never the default branch.
Done when: GitLab mock tests for first proposal, second proposal (one MR updated), a pool with no fleet (409), no permission, and a file already at the path (refused, not overwritten); `/security-review` run on the diff.

### ELR-9 - Measure and pin the weight of a run  `[ ]` S - deps: POOL-3
Do: a test that generates a representative run (three stacks, one with policy, one costed, one with an environment) and counts jobs, distinct images and pipeline hops; the numbers are asserted and written to `docs/pipeline-weight.md` with the date. The same file counts the jobs per dependency level in the GitHub stack workflow.
Done when: adding a job or an image makes the test fail with the old and new count. No generated pipeline changes.

### ELR-10 - Shallow clone, and no clone for helper jobs  `[ ]` S - deps: ELR-9
Do: `GIT_DEPTH: 1` on tool jobs; `GIT_STRATEGY: none` on the summary and estimate jobs, only where a test proves the job reads only artifacts and the network. Only for stacks on a fleet pool.
Done when: snapshots with and without a fleet pool (the second byte for byte unchanged); a test fails if a `GIT_STRATEGY: none` job script reads a path outside its artifacts.

### ELR-11 - Provider cache for fleet pools  `[ ]` M - deps: ELR-9, ELR-3
Do: for a stack on a fleet pool, `TF_PLUGIN_CACHE_DIR` and `cache:` keyed on `files: [<dir>/.terraform.lock.hcl]`, paths the provider directory, policy `pull-push` on plan and `pull` on apply; the fleet modules render `[runners.cache]` for the bucket (as verified in ELR-4).
Done when: snapshots; the cache never covers `plan.tfplan` or `plan.json` (a test); a stack with no lock file still generates.

### ELR-12 - The images a pool's stacks use  `[ ]` S - deps: ELR-7
Do: one function returning the distinct images a pool's stacks would use (tool, pool image, helper, policy, cost), from the same code that picks them in the generator; the renderer writes them to the module as `prepull_images`.
Done when: a test builds a pipeline and a pool's image list and fails if they differ; the module pulls them at instance start (or is documented to, per ELR-4).

### ELR-13 - Health words for a fleet  `[ ]` S - deps: ELR-3
Do: the pool status response gains `fleet: true` when the pool has one; `offline` for a fleet says in `reason` that the fleet is not applied or its manager is down. The states themselves do not change.
Done when: mock tests for a fleet pool online, offline, unknown; a plain pool's answer is byte for byte unchanged.

### ELR-14 - CLI  `[ ]` M - deps: ELR-3, ELR-8, ELR-13
Do: `orch pool add … --fleet aws:eu-west-2 --profile … --max … --idle … --use-count …`; `orch fleet render <pool>` (prints the files); `orch fleet propose <pool> --project … [--connection …]`; `orch pool ls` shows a fleet column. A mistake in the words exits 2 before the API is asked.
Done when: command tests for each, with `--json`; the existing pool tests are unchanged.

### ELR-15 - Settings: the pool row shows its fleet  `[ ]` M - deps: ELR-8, ELR-13
Do: in the Settings pools section, a fleet summary on the row (cloud, region, profile, ceiling, idle), its status in words with a glyph, and **Propose fleet** in a `Drawer` (project, path, the file list before sending). No form to create a fleet in the page: `orch` or the API makes it, as with pools.
Design: not needed, reuses the Settings pools section with `Card`, `StatusBadge` and `Drawer`.
Done when: component tests for no fleet, applied, not applied and unknown; `bun run e2e` (layout at 390 px) green; the accessibility scan on the running page, or named as not run.

### ELR-16 - Docs and demo  `[ ]` S - deps: ELR-14, ELR-15
Do: `docs/runner-fleets.md` (what it creates, what it costs when idle, the token, the cold-start cost, what is not covered; the GARM section is added with ELR-22); a sentence in `docs/worker-pools.md` and ADR-0015's consequences pointing to it; a fleet pool in the demo seed.
Done when: `bun run check` is green and the demo shows the row.

### ELR-17 - First real fleet (GitLab)  `[!]` M - deps: ELR-16 - human gate
Do: on a sandbox AWS and a sandbox GCP account: apply the proposed stack, run one pipeline of three stacks, record the cold start per job, watch the group return to zero. Anything that differs from the docs goes into `docs/runner-fleets-spike.md` and the SPEC.
Done when: you ran it. Blocked until then; nothing else waits on it.

### ELR-18 - Pools on GitHub: `runs-on` from the plan data  `[ ]` M - deps: ELR-1, ELR-3, ELR-4
Do: the stack plan data (FRG-17) carries each stack's pool labels; the static stack workflow takes `runs-on` from the matrix entry; a stack naming an unknown or disabled pool refuses the run by name (as on GitLab); a stack with no pool keeps today's `runs-on`. Update `docs/forges.md` and the ADR-0019 refusal list in code and docs.
Done when: workflow snapshot tests with and without a pool (the second byte for byte unchanged); a plan-data test for an unknown and a disabled pool; a test that fails if a fleet `runs-on` is reachable from a fork's `pull_request`; `actionlint` if installed, or named as skipped.

### ELR-19 - Runner health on GitHub  `[ ]` S - deps: ELR-3, ELR-18
Do: `runners.list` on the GitHub adapter (`GET /repos/{o}/{r}/actions/runners` and the organization form, through the forge seam only), mapped to the same online/offline words as POOL-4; capability flag `runners` true for GitHub; ELR-13's wording applies.
Done when: contract tests over both mock forges (GitLab ones unchanged); pool status tests for a GitHub fleet pool online, offline, unknown.

### ELR-20 - GARM fleet module, AWS  `[ ]` M - deps: ELR-2, ELR-4
Do: `packages/iac/fleet/github-aws/`: the manager VM (not spot) running GARM, its provider for AWS, a launch template for job VMs with no role, the pool(s) from the fleet values, the GitHub credential and webhook secret in Secrets Manager, an inbound HTTPS listener restricted to what the spike found, a cache bucket.
Done when: opt-in `terraform validate`; plain tests: job-VM profile has no actions, the manager role is scoped to its own VMs, the webhook port is the only inbound rule and is not open to anything the spike did not name; `/security-review` run.

### ELR-21 - GARM fleet module, GCP  `[ ]` M - deps: ELR-2, ELR-4
Do: `packages/iac/fleet/github-gcp/`: the same on Compute Engine and Secret Manager, a service account with no roles for job VMs.
Done when: the same tests; `/security-review` run.

### ELR-22 - Render and propose a GitHub fleet  `[ ]` M - deps: ELR-8, ELR-20, ELR-21
Do: `renderFleet(pool, forge)` picks the GitLab or GARM modules by the infrastructure project's connection; the propose route (ELR-8) opens a pull request on GitHub; same branch name, never the default branch.
Done when: snapshots for GARM on AWS and GCP; the injection test through the GARM path; mock-GitHub tests for first proposal, repeat (one PR), a file already at the path (refused); the GitLab tests unchanged.

### ELR-23 - First real GitHub fleet  `[!]` M - deps: ELR-22, ELR-18, ELR-19 - human gate
Do: apply the proposed stack in a sandbox AWS and GCP account against a sandbox GitHub repository, run one workflow of three stacks on the fleet, record the cold start and the return to zero, and check that a fork's pull request does not use it.
Done when: you ran it. Blocked until then.

### Conditional on question 4 (not scheduled)
ELR-24 one `summary` job per run; ELR-25 helper jobs on a named warm pool. Added only if you say yes after ELR-9. Both GitLab only.
