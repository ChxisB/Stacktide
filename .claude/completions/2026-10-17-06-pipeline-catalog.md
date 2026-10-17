# 06 pipeline-catalog: done (2026-10-17)

All 9 tasks `[x]`. Gate: `bun run check` green, 2088 pass + 1 skip (the opt-in real-instance GitLab contract run) + 0 fail, 87 files. One local commit per task, nothing pushed.

| Task | Commit | What |
|---|---|---|
| PIPE-1 | 08ee974 | Template manifest (zod) and loader for `packages/pipelines/templates/` |
| PIPE-2 | 907ade4 | Starter templates `bun-app`, `node-app` and `docker-image`, with manifests |
| PIPE-3 | 5e7d194 | Layered renderer: params checked against the manifest, substituted into parsed string values only, overrides merged, written the same way every time, read back as YAML 1.1 and 1.2 |
| PIPE-4 | 373088c | Template recommendations from a project's detected kinds |
| PIPE-5 | 6a727ec | Validation: GitLab lint through the connection, and required variables that are not set |
| PIPE-6 | bfdf95a | Apply through one merge request on `orch/pipeline` (never the default branch); re-runs update it; stored configuration; audit |
| PIPE-7 | 192dd41 | Fleet upgrade of pinned projects in rate-limited batches, plan and apply |
| PIPE-8 | b842a91 | Pipeline status ingestion from webhooks (the worker reads GitLab's answer), list/latest, and retry of failed pipelines |
| PIPE-9 | 49b92de | Include mode: a thin `.gitlab-ci.yml` that includes the template from a templates project; eject by applying again inline; `bun run templates:include <dir>` writes the files to publish |

Details, mutation results and review outcomes per task are in `06-pipeline-catalog/LOG.md`.

## Not done: human gates

- **The first real merge request, the first fleet upgrade and the first include-mode lint were never run against a real GitLab.** Every test uses the mock (which resolves `include:project` and `inputs` only as far as the tests need). Try a sandbox project: apply, read the MR, merge it, watch the pipeline run, and for include mode publish the files with `bun run templates:include` first.
- **Include files are published by a person.** The platform never writes the templates project.

## Decisions to review (REVIEW-tagged in the LOG)

- **Authz model, new actions**: `pipeline.read` (project reporter), `pipeline.apply` (org admin: preview and apply use the connection's token, and `overrides` can add any job), `pipeline.upgrade` (org admin; list, plan and apply), `pipeline.retry` (project maintainer).
- **Include mode runs foreign code.** Once the MR is merged, the project's pipeline runs whatever the templates project's maintainers publish; any project the connection can read is accepted as the templates project. The MR says so. An allowlist or one configured templates project per organization is a design decision left to you.
- **Migrations, all additive**: 0018 (`pipeline_configs`), 0019 (`pipeline_runs`), 0020 (`pipeline_configs.mode`, `include_project`, `include_ref`; existing rows are `inline`).
- **Delete semantics**: project -> pipeline_configs CASCADE; connection -> pipeline_configs RESTRICT; project -> pipeline_runs CASCADE; connection -> `pipeline_runs.connection_id` SET NULL (history kept, the run cannot be retried until a new event re-reads it).
- **New dependency**: `yaml` 2.8.1 (PIPE-3), for the renderer's stable output and the YAML 1.1/1.2 read-back.

## Remaining risks and open follow-ups

- **Templates and renderer**: symlinked template directories are ignored; ReDoS is only mitigated by a length cap on manifest patterns (repo-trusted); `!reference` and tags are refused, template comments are dropped, there is no way to delete a key through overrides; templates cannot contain a literal `{{ params.x }}`; manifest strings must declare `enum` or `pattern`; params and overrides are stored and committed in the clear (never secrets; `overrides` values are unbounded in size); rendered pipelines are never linted by a real GitLab (see above).
- **Starter templates**: `bun.lock` as cache key assumes Bun 1.2+; a project without the expected `package.json` scripts needs other script names or overrides; docker-image needs a DinD-capable runner and a registry, and `latest` moves on every default-branch pipeline; every check job uploads the same cache.
- **Detection and recommendations**: path-based; only the newest template version is offered; no ranking beyond confidence and name; Terraform/Terragrunt get no template until the IaC feature.
- **Validation**: "set" means a live variable of that name at org, project or environment level (value, kind and sync are not checked); names are case-sensitive; the mock's lint only knows "a job has a script", so real GitLab's warnings are unverified; missing required variables do not block an apply (they are listed in the MR).
- **Apply**: no lock on concurrent applies; a closed MR is recreated on re-run; a leftover `orch/pipeline` branch is reused as it is (it may be stale against the default branch); `in_place` leaves an open MR open and clears the stored link; GitLab is written before the database, so a database failure leaves an MR with no audit row and a re-run converges; the default-branch file is read once; org-default and per-environment layers are not stored or applied; a re-run with the version omitted upgrades to the newest; a hand-written file is detected only by the `# Generated by orch from template` header.
- **Fleet upgrade**: progress is the stored version, so permanently blocked or failed projects are retried from the start on every run unless the caller passes `after`; the rate limit is the batch size (at most 50) plus a fixed 500 ms between GitLab-touching projects, with no global or per-token budget; the call is synchronous, so a slow batch holds the request; `upgraded` means the MR carries the new version, not that it is merged; the dry-run diff is an approximate line count against the default-branch file; no early abort after consecutive failures; plan and apply are separate and not bound to each other; only the same template is upgraded; a project pinned newer is skipped but takes a batch slot; no lock against concurrent upgrade calls.
- **Status ingestion and retry**: the webhook is only a notification, so the worker needs its own `ORCH_MASTER_KEYS` and a working token (without keys the `gitlab.event` queue is not served), and the project hook must send Pipeline events; ordering is by the database clock at millisecond precision; the pipeline GET and the jobs listing are two calls, so a status that disagrees with the failure can be stored until the next event; **no environment attribution** (latest-per-ref only; mapping a ref to an environment is left to the IaC and governance features); the failure is the first failed, non-allowed job only; no retention of runs and no rate limit or lock on retry; retry uses the connection that last read the pipeline and only for `failed` or `canceled` runs; if the re-read after a retry fails, the retry has still happened (502); ingestion writes no audit row (the webhook delivery row is the record); real hook payloads and job `failure_reason` behaviour are unverified.
- **Include mode**: GitLab's include and inputs semantics are unverified (whole-value `$[[ inputs.x ]]` keeping its type, `options`, merge order, error texts); `regex`, ranges and lengths are not emitted (GitLab's `regex` is RE2 and the manifests use lookahead), so the platform checks them only when it renders and a hand-edited thin file bypasses them (an integer is a GitLab `number`); `ref` is optional and there is no pinning beyond the version in the path; overrides reach included jobs only through GitLab's same-name job merge; the thin file's lint needs the connection token to read the templates project; a fleet upgrade is blocked until the new version is published there; eject has no dedicated endpoint (apply again without `mode`; the caller supplies the template and parameters again); CI components and the catalog, `file` lists and other include kinds are not modelled.
- **Mutation survivors left on purpose**: PIPE-3 R17/R20, PIPE-6 A25, PIPE-7 D8/R10, PIPE-8 R5, PIPE-9 I19/K5; each is equivalent (reasons in the LOG). Every other mutant checked was killed.
