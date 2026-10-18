# 09 IaC Stacks and Runs - Tasks

### IAC-1 - Stack model and discovery  `[x]` M - deps: GL-2, API-2
Do: `stack.yml` zod schema; `stacks` table; scanner that reads the repo tree and markers (`packages/iac`); reports stacks missing `backend "http" {}`.
Done when: fixture trees cover valid, invalid, duplicate-name and nested stacks.

### IAC-2 - Dependency DAG  `[x]` M - deps: FND-3
Do: pure graph build, cycle detection with readable path, topological waves, `affected(changed)` with transitive dependents.
Done when: table + property tests (random DAGs) prove wave order, cycle errors and dependent closure.

### IAC-3 - Change detection  `[x]` S - deps: IAC-1, IAC-2, GL-2
Do: from MR source/target SHAs use the compare API -> changed paths -> affected stacks (dir match + `watch` globs).
Done when: tests cover module-path changes, deleted files, renamed files and no-op MRs.

### IAC-4 - Child pipeline generation  `[x]` M - deps: IAC-2, IAC-3, GL-3
Do: generate pipeline YAML for a set of stack actions: per-stack jobs, `needs` by wave, `resource_group`, tool setup by version, `id_tokens`, plan artifact, summary post step.
Done when: snapshot tests plus GitLab CI lint on the output (mock) pass; a cycle or missing tool version fails generation loudly.

### IAC-5 - Run model and state machine  `[x]` M - deps: IAC-1, API-6
Do: `runs` + `run_stacks` tables; pure transition table; create/list/get API; audit.
Done when: tests cover every legal transition and reject every illegal one.

### IAC-6 - Ingest: webhooks and plan summaries  `[x]` M - deps: IAC-5, GL-8, AUTH-6
Do: pipeline/job webhooks move run states; `POST /runs/:id/plan-summary` accepts add/change/destroy counts and a resource list from the job (ci principal must match project, ref and stack).
Done when: tests cover out-of-order and duplicate events, a mismatched ci principal (403) and size limits.

### IAC-7 - MR integration  `[x]` M - deps: IAC-4, IAC-6, GL-2
Do: on MR open/update create a plan run, trigger the generated pipeline, and create-or-update **one** MR note with a per-stack table (status, counts, job links).
Done when: tests show the note is updated not duplicated, stale pushes cancel superseded runs, and no plan contents beyond counts and resource addresses are posted.

### IAC-8 - Apply flow  `[x]` M - deps: IAC-7, AUTH-3
Do: preconditions (fresh head SHA, approved, mergeable, no active run, authorised), apply the saved plan artifact, apply on merge when `apply_on: merge`, record outcome. **First real apply is a human gate.**
Done when: tests cover each failed precondition, double-apply prevention and a failed apply leaving the stack `failed` with the reason.

### IAC-9 - MR note commands  `[x]` S - deps: IAC-8, GL-8
Do: parse `orch plan|apply [stack]` from note webhooks; authorise via AUTH roles; reply with a note.
Done when: tests cover unknown stack, unauthorised user, ambiguous command text and quick-action-looking input.

### IAC-10 - State backend wiring  `[x]` S - deps: IAC-4
Do: inject GitLab-managed state env into generated jobs (state name per stack); passthrough for a custom backend declared in the marker.
Done when: generated jobs init against a fake HTTP backend in a test, with lock/unlock hit.

### IAC-11 - Stack variables  `[x]` M - deps: IAC-4, CLI-5, VAR-4
Do: jobs obtain platform variables as `TF_VAR_*` via `orch ci login && orch run` (OIDC), not via stored CI variables.
Done when: a test shows the generated job has no secret literal and the resolved set maps names to `TF_VAR_` correctly.
