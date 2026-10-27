# 34 On-demand Environments - Tasks

Cuts: A (ODE-1..2, decision and audit, no product code), B (ODE-3..4, describe and record), C (ODE-5..8, create), D (ODE-9..12, destroy, GitLab), E (ODE-13..14, timer), F (ODE-15..18, surfaces), G (ODE-20..21, blueprints and GitHub destroy). ODE-19 is a human gate. Cuts C to E are usable from the API and CLI before the page exists. "MR" means a pull request on GitHub (see the SPEC).

### ODE-1 - ADR-0023: environments are stack selections; create is a merge request; destroy is a run  `[ ]` S - deps: -
Do: write the ADR. Options for create: (a) clone by merge request (recommended), (b) instances of one parametric stack started by pipeline, (c) the platform calls the cloud (rejected: invariant 3). Options for teardown: destroy run with `destroy: allow`, typed name, change request for protected, timer for ephemeral only. Say what it adds to invariant 5 (delete is opt-in) and that D1 and invariant 3 do not change. **Human gate; no code.**
Done when: you accept or change it. D18 is added to the ROADMAP only after that.

### ODE-2 - Audit: onboarding a plain Terraform repository, and what a run records  `[ ]` S - deps: ODE-1
Do: read-only. Write `docs/environments-spike.md`: exactly what the Carebell example needs before it can be cloned (a `stack.yml` per stack; `http` backends and the migration step), how `scan` treats a directory with Terraform and no marker, whether the import offers to propose markers, where a run records its kind (plan, apply, drift) and how a stack's state is stored (GitLab's per stack name, the platform's `state: orch` per what key, so a copied stack's state is known to be its own), what the GitHub stack workflow and its plan data would need for a destroy, so ODE-4, ODE-6, ODE-9 and ODE-21 are written against facts.
Done when: the doc lists each item with the file it came from; nothing is edited or run.

### ODE-3 - Describe a stack: `title`, `kind`, `optional`, `destroy`  `[ ]` S - deps: ODE-1
Do: four optional keys in the `stack.yml` schema and `scan` (`title` short text, `kind` one of a closed list, `optional` boolean default true, `destroy` `allow` or `refuse` default `refuse`). Closed charsets: they reach the page and a generated job.
Done when: `stack.test.ts` and `scan.test.ts` cover each key, each refusal, and a marker without them parsing exactly as before.

### ODE-4 - Record an environment's life  `[ ]` M - deps: ODE-2, ODE-3
Do: additive migration: `environments.ephemeral` (default false) and `environments.expires_at` (nullable); stack state `destroyed`; a function deriving an environment's state (`creating`, `live`, `destroying`, `destroyed`, `failed`) from its stacks. Nothing existing reads the new columns.
Done when: db tests for the derivation over every mix of stack states; the existing environment tests are unchanged; OpenAPI regenerated.

### ODE-5 - Selection closure  `[ ]` S - deps: ODE-3
Do: a pure function: template environment's stacks plus a list of picks → the stacks to clone, with `required` marked, by following `depends_on` through the existing graph. Unknown pick, a cycle, and a pick that is not in the template are errors by name.
Done when: tests for no picks (only `optional: false`), one pick that pulls two others, a cycle, an unknown name.

### ODE-6 - Scaffold the clone  `[ ]` M - deps: ODE-5
Do: `scaffoldEnvironment(template, files, name)`: for each stack, the directory's text files copied with the template slug path segment replaced, `stack.yml` `name` and `environment:` rewritten. Refuses (by stack name, with the reason): a path with no slug segment, a backend that is not `http` (on GitHub also a stack whose `state: orch` key ODE-2 found is not per stack), a binary file, more than 100 files or 1 MiB per stack. Pure; no network.
Done when: tests for a clean clone, each refusal, the Carebell shape (a `gcs` backend with a fixed prefix is refused naming the stack), and that nothing outside the chosen directories is produced.

### ODE-7 - Create an environment: the route  `[ ]` M - deps: ODE-4, ODE-6
Do: `POST /organizations/:orgId/projects/:projectId/environments` `{name, template, picks, ephemeral?, ttl?, connectionId}` (maintainer, deny by default, audited as `environment.create` with the stack names): inserts the environment, opens one merge request through the delivery code the pipeline onboarding uses, never a default branch, same branch name on a repeat. Variables are not copied (non-secret copy on request is ODE-7's flag, secrets never). The organization cap on live ephemeral environments is checked here.
Done when: mock tests, **on both the GitLab and the GitHub mock**, for create, repeat (one MR or PR), a refused stack (nothing inserted, nothing opened), over the cap (409), no permission; a leak test finds no variable value in the response, audit row or MR; `/security-review` run.

### ODE-8 - The clone is planned by the existing flow  `[ ]` S - deps: ODE-7
Do: no new feature code. An integration test on the mock: the MR ODE-7 opens is planned in wave order, each cloned stack gets its plan job, summary and (with a limit) estimate, and an apply is gated as today.
Done when: the test passes on the GitLab mock with no change to `pipeline-gen.ts` or the run flow, and on the GitHub mock with no change to the stack workflow; if either needs one, the task is split and the change is its own task.

### ODE-9 - Generate the destroy pipeline (GitLab)  `[ ]` M - deps: ODE-2, ODE-3
Do: in `pipeline-gen`, a `destroy` action: per stack in **reverse** wave order a `plan -destroy` job saving `plan.tfplan`, its summary, and an apply job of that plan; Terraform and OpenTofu only; a stack without `destroy: allow` or a Terragrunt or DNS stack refuses generation by name. Pool tags and the lighter settings apply as for any job (the structural test must cover the new jobs).
Done when: snapshots for two dependent stacks (order reversed), the refusals, and the existing structural test (every job carries its pool's tags) green over the new jobs.

### ODE-10 - Destroy an environment: the route and the gates  `[ ]` M - deps: ODE-4, ODE-9
Do: `POST …/environments/:slug/destroy` `{confirm}` (maintainer, audited `environment.destroy`): refuses a wrong name, a stack without `destroy: allow`, a protected environment without an approved change request (reuse the `deploy`/`apply` gate shape of 11), and a second destroy while one runs (a unique index, as for applies). Claims the stacks (`applied` to `destroying`) and starts the pipeline in one transaction; a refusal by GitLab leaves every stack as it was.
Done when: mock tests for each refusal and the happy path on the GitLab mock (the GitHub path is ODE-21); a stack is claimed once under two concurrent calls; `/security-review` run.

### ODE-11 - Destroy events move the stacks  `[ ]` S - deps: ODE-10
Do: the pipeline-event handlers move a stack `destroying` to `destroyed` when its apply job succeeds, to `failed` when it fails (state kept), and the run note says which. Drift checks and the plan flow skip a `destroyed` stack.
Done when: event tests for success, failure, a retried job, a late event; the drift worker test shows a destroyed stack is never asked for.

### ODE-12 - What a destroy says, and what it leaves  `[ ]` S - deps: ODE-11
Do: the destroy summary lists counts of data-bearing resource types from an allowlist (databases, buckets, key rings and keys, volumes), types and counts only; the confirm response carries them; after the environment is `destroyed`, a second route proposes an MR that removes its directories.
Done when: tests with a plan JSON containing a database and a bucket; no address or value leaves the summary (leak test); the removal MR touches only the environment's directories.

### ODE-13 - The timer  `[ ]` M - deps: ODE-10, ODE-4
Do: the worker tick finds environments with `ephemeral` and `expires_at` in the past, not destroyed, and starts a destroy as the actor `system` (audited); `PATCH …/environments/:slug` `{ttl}` extends (maintainer); a unique guard so a tick that repeats starts one; `ephemeral` cannot be turned on for a live environment except by a change request.
Done when: worker tests with a fake clock: expired ephemeral destroyed once across two ticks, a non-ephemeral never, an extended one not, a destroy that fails is not retried by the tick (a person decides); `/security-review` run.

### ODE-14 - Notifications  `[ ]` S - deps: ODE-13
Do: sink events `environment.expiring` (an hour before), `environment.destroyed` and `environment.failed` with the environment name, project and time, nothing else; same signing and retry as the existing sinks.
Done when: delivery tests for each event; the body has no stack address or variable.

### ODE-15 - CLI  `[ ]` M - deps: ODE-7, ODE-10, ODE-13
Do: `orch env ls|show`, `orch env create <name> --from dev --pick database --pick cloud-run [--ephemeral --ttl 8h]`, `orch env destroy <name> --confirm <name>`, `orch env extend <name> --ttl 3d`; `show` lists the template's variable names still to fill. A mistake in the words exits 2 before the API is asked.
Done when: command tests for each, with `--json`, and for the refusals' wording.

### ODE-16 - Web: the picker  `[ ]` M - deps: ODE-7, ODE-5, RSH-2
Design: **to be made and approved first, together with feature 37 (RSH-2)** (see the SPEC): the New environment picker (resources with locked requirements, name, ttl, cost note, the variable names to fill).
Do: build from the approved design with `PageHead`, `Card`, `Chips`, `Drawer`.
Done when: component tests for no template, locked requirement, over the cap, refused stack; `bun run e2e` (390 px, both themes) green; `web-design-guidelines` and the accessibility scan run on it, or named as not run.

### ODE-17 - Web: environment status and Destroy  `[ ]` M - deps: ODE-11, ODE-12, ODE-16
Design: from the same approved design (the status section and the Destroy dialog).
Do: a stack list with state words and glyphs, the expiry with Extend, **Destroy** in a centered `Drawer` that lists the data-bearing counts and asks for the name typed.
Done when: component tests for live, destroying, failed, expiring and destroyed; the dialog cannot be confirmed without the name; keyboard and focus checked with `accessibility-inspect`, or named as not run.

### ODE-18 - Docs, demo and a journey  `[ ]` S - deps: ODE-15, ODE-17
Do: `docs/environments.md` (what create and destroy do and refuse, the shared-state rule, Carebell as the worked example, what is not covered), a template environment and one ephemeral environment in the demo seed, one journey test on **each** mock forge (create, plan, apply, destroy).
Done when: `bun run check` and `bun run e2e` are green.

### ODE-19 - First real environment  `[!]` M - deps: ODE-18, ODE-21 - human gate
Do: on a sandbox GCP project and AWS account, from a GitLab project and a GitHub repository: create an environment from a template, plan, apply, and destroy it; try the timer on an ephemeral one with a short ttl. Differences go into the SPEC and `docs/environments-spike.md`.
Done when: you ran it. Blocked until then.

### ODE-20 - Create an environment from blueprints  `[ ]` M - deps: BLP-13, BLP-14, ODE-7
Do: `POST …/environments` accepts `blueprints: [{kind, cloud, name, uses}]` instead of `template` and `picks` (exactly one of the two, else 422); it validates each entry with feature 35's schema, renders with `renderBlueprint`, adds the environment row, and opens one MR or PR with every stack, wired by `uses`; `GET /blueprints` already lists what can be picked. The org's ephemeral cap and the audit event apply as in ODE-7.
Done when: mock tests on both forges for a service + postgres + network environment, an invalid entry (nothing inserted), both `template` and `blueprints` given (422), over the cap (409); a leak test; `/security-review` run.

### ODE-21 - Destroy on GitHub  `[ ]` M - deps: ODE-10, ODE-11, ODE-2
Do: the stack plan data (FRG-17) carries `action: destroy` with stacks in reverse wave order; the static stack workflow runs `plan -destroy` and then the apply of that saved plan per level; the destroy route on a GitHub project checks the delivered workflow file is current and otherwise answers with the workflow-update sentence (and offers the pull request that updates it); events from the `workflow_run` webhook move stacks `destroying` to `destroyed` or `failed` as ODE-11 does.
Done when: workflow snapshot tests (reverse order, the saved plan is the one applied, no `-auto-approve` on a plan not shown); route tests on the GitHub mock for an old file, a current file, a wrong typed name, a protected environment without a change request; the existing stack workflow tests unchanged; `/security-review` run.

### Backlog (not broken down)
Previews per merge request (create on open, destroy on close; question 7). Instance mode (one parametric stack, no merge request). Terragrunt destroy. A budget alarm.
