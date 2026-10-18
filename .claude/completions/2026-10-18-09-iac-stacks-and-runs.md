# 09 iac-stacks-and-runs: 11 of 11 built, first real run still a human gate (2026-10-18)

IAC-1..11 `[x]`. Gate: `bun run check` green, 2937 pass + 1 skip (the opt-in real-GitLab run) + 0 fail (root), 239 pass + 0 fail (web). One local commit per task, nothing pushed. The feature is `done` in the ROADMAP for the code; **nothing in it has run against a real GitLab, a real pipeline or real Terraform state** (see "Not done").

| Task | Commit | What |
|---|---|---|
| IAC-1 | da1ae66 | `stack.yml` marker, repository scanner, `stacks` table mirror of the default branch |
| IAC-2 | 83e86a6 | Dependency graph: cycle paths, waves, dependents |
| IAC-3 | 711f16c | Change detection from a GitLab comparison (which stacks an MR touches) |
| IAC-4 | 4abf978 | Child pipeline generation for plan and apply: waves, `needs`, resource groups, `id_tokens` |
| IAC-5 | 9ad96a9 | Run model, state machine and run API (`run.read`, `run.create`, `run.apply`) |
| IAC-6 | f7c5586 | Run ingest from pipeline events and plan summaries (counts only) |
| IAC-7 | 02c184a | Merge request plans and one updating MR note |
| IAC-8 | d34a6c4 | Apply flow (approved MR, head commit matches the plan, per-stack mutex) |
| IAC-9 | 69b998b | MR note commands (`orch plan`, `orch apply`), roles from GitLab membership |
| IAC-10 | cd0ddd5 | GitLab-managed state wiring (`TF_HTTP_*` references) for generated jobs |
| IAC-11 | 2522990 | A stack's platform environment becomes `TF_VAR_*` in its plan job; `orch run --prefix`; tool image settings |

Details, mutation results (every security-critical behaviour mutated, all killed) and review outcomes per task are in `09-iac-stacks-and-runs/LOG.md`. No route was added after IAC-8 (route guard 94, OpenAPI operation guard 92). New dependencies: none third-party; `@orch/iac` as a workspace devDependency of `apps/cli` (IAC-11 end-to-end test only).

## Not done: human gates

- **The first real apply.** Everything that talks to GitLab or to a pipeline was tested against the mock and fakes: the `wget` / `CI_JOB_TOKEN` plan fetch, the helper image (`orch`, `curl`, `jq`), GitLab's approval, `detailed_merge_status` and `/approvals` semantics, `source_pipeline` webhook field names, cascade-cancel of children, whether the job token can lock and write GitLab-managed state, `artifacts:access: developer` (believed GitLab 16.11+), `environment: action: access`, and that the tool image really contains `orch`. Run one plan and one apply against a sandbox project and group before relying on any of it.
- No part of this feature wrote to a real GitLab, a cloud account or a real state backend.
- The documentation (`docs/iac.md`, `docs/ci.md`) states each of these as believed or unverified.

## Decisions to review (REVIEW-tagged in the LOG)

- **Marker (IAC-1, IAC-11):** `apply_on` defaults to `command`; `version` is optional (a plan without it is refused); nested stacks are allowed; `environment` was added to the marker schema. The `stacks` table mirrors the default branch and deletes missing rows only with `prune` on a complete scan; `environment` is not mirrored. Limits: 500 markers, 50 `.tf` files, no `.tf.json`, a heredoc is misread, nothing is pruned while any marker fails to read; a Terragrunt backend is not checked.
- **Graph (IAC-2):** longest-path waves; one cycle reported per group; a dependency on a stack that failed to scan is an `unknown-dependency`.
- **Change detection (IAC-3):** nested stacks are the closest stack only; a directory-named `watch` covers everything under it; an incomplete comparison plans everything; a stack removed by the MR is not planned; the 1000-file cut-off is unverified; `watch` is repository-relative and its schema was tightened.
- **Pipelines (IAC-4):** one action per pipeline; a plan pipeline plans dependents against the current state; **plan artifacts hold the values of secrets**, protected only by `access: developer` and a 1-week expiry; no default Terragrunt image; cloud OIDC tokens are one global name-to-audience map; a plan waits behind an apply of the same stack.
- **Authz (IAC-5, IAC-6, IAC-8):** `run.create` developer and `run.read` reporter while `pipeline.retry` is maintainer; `run.apply` maintainer; `run.summary` is given to every environment-less CI token, and a summary is bound to the recorded summary job (a late or lost pipeline event gives 403).
- **Apply (IAC-8):** the pipeline starts inside the DB transaction before commit (an orphan GitLab pipeline is possible if the commit fails); a merged request's pipeline runs on the target-branch head, not the planned commit (`pipelineSha` is audited); a merge-path apply is all-or-nothing and nothing re-triggers it; a plan's expiry is approximated from `updatedAt`; "applied" rests on the job name `apply:<stack>`; CI-file protection is not checked; the opt-in is read at the planned commit, so an MR can opt itself in.
- **MR commands (IAC-9):** the author's roles come from GitLab membership with a 5-minute worker-side cache (a demoted maintainer may apply for up to 5 minutes); the audit actor is `gitlab_user:<id>`; a real Note Hook may or may not send `object_attributes.action`; an edited note never runs; a command refused for a reader is logged, not audited; the command is lost when the worker's retries run out.
- **State (IAC-10):** the state is named after the stack, so renaming orphans it; a custom backend is detected from `.tf` text with no marker override.
- **Variables (IAC-11):** tool plan jobs now hold the platform id_token (relaxing IAC-4's "tool jobs hold none"); `orch run` withholds it from the tool but not from the job's shell. **Whoever can push a branch chooses the `environment` and the code reading it**, so real secrets belong in a protected environment (which needs a protected ref). A tool-image override applies to every stack of that tool.

## Remaining risks and open follow-ups

- **IAC-4:** the jq filter repeats per summary job; the summary route and path are caller-supplied, the lock timeout is a fixed 5 m, a summary lists at most 500 resources, `needs` is capped at 50; any graph error blocks generation.
- **IAC-5:** a run has no state of its own, no cancel or discard route yet; at most 100 stacks per request; no retention or limit on runs per project; a project-delete race gives a 500.
- **IAC-6:** a failed or refused summary leaves the stack `planned` without counts; retrying a failed plan job does not revive a failed stack; `MAX_LISTED = 500` is duplicated between the generator and the route; `run_pipelines` carries an unused `updated_at`.
- **IAC-7:** each project adds the parent `.gitlab-ci.yml` snippet from `docs/iac.md` (no template yet); fork MRs are refused; only projects tagged terraform/terragrunt at import are planned; the MR author controls `.gitlab-ci.yml` and jobs are matched by name; more than 100 affected stacks are not planned; the note is rewritten on every pipeline event; the per-MR lock holds a transaction across GitLab calls.
- **IAC-8:** `supersedeRuns` discards the planned stacks of a run whose other stacks are applying; a run without an MR cannot be applied; a merged MR can be applied by command with an older plan.
- **IAC-9:** `orch plan <stack>` is not supported; bot replies each cost one `getNote`.
- **IAC-11:** three audited `secret.reveal`s per environment stack per plan; the Terraform variable name must match the platform key's case; the job's own `TF_VAR_*` still pass through `--prefix`.
- **The `stacks` table is never filled in production** (found in feature 10): `syncStacks` has no caller outside tests, so `POST /runs` answers 422 `unknown_stack` for every real project. Merge request planning is unaffected because it scans the repository itself, and so does drift (POL-1). A caller (a scan on import, or a worker step) is the follow-up.
