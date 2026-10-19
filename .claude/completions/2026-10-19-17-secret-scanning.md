# 17 secret-scanning - done 2026-10-19

## What was built
- **SCAN-1** `parseSecretReport` in core: an allowlist parser for GitLab's `gl-secret-detection-report.json`. Only rule, path, line, commit, severity and the scanner's fingerprint are kept; the secret, matched text, description, extract and commit message and author are never read. Over 5 MB, not JSON of the shape, or over 1000 findings is dropped with a reason.
- **SCAN-2** `secret_findings` (unique per project and fingerprint) with `upsertFindings`: new is `open`, seen again moves `last_seen_at`, a scan of the default branch that finished and looked at everything resolves what it no longer has, a dismissal is never undone by a scan, a branch's finding is never resolved automatically. A test pins the column list.
- **SCAN-3** When a pipeline of a linked project finishes, the worker lists its jobs and, for a job named `secret_detection`, downloads the report artifact through the project's connection (`packages/gitlab`, capped read). Malformed or large reports are dropped, GitLab failing is retried.
- **SCAN-4** `GET` findings (any member, paged, `?status=`), `GET` one, `POST dismiss` (reason required) and `POST reopen` (maintainer), both audited with rule and path.
- **SCAN-5** `secretDetection` as a platform parameter of the starter templates: GitLab's own template included, a `secret_detection` job in the right stage, off by default; `GET …/pipeline` answers `warnings` about runners.
- **SCAN-6** An organization gate `off | warn | deny` (migration 0041, default off; `GET`/`PUT /organizations/:orgId/secret-gate`, audited): `warn` adds a `Secrets:` line to the merge request note, `deny` refuses the apply with `409 secret_findings_open` on the command and the merge path alike. The verdict goes through `judge` like the policy and cost verdicts.
- **SCAN-7** `orch findings ls|dismiss|reopen` and a **Findings** page in the navigation (Open / Dismissed / Resolved / All, the revoke-at-the-source notice, dismiss with a required reason, reopen).
- Docs: `docs/secret-scanning.md`.

## Results
Final `bun run check` after the review fixes: EXIT 0 (root and web `tsc`, Biome, 4676 tests pass, 2 skip, 0 fail; web 265 pass). New dependencies: none. Migrations: 0040 (findings) and 0041 (gate), both additive.

## Invariants
No plaintext secret: the parser keeps an allowlist of fields, a test plants a canary in every free-text field of a report and finds it in no row, answer, audit event, log line or page. All GitLab traffic goes through `packages/gitlab`. The control plane holds no cloud credential and cannot revoke what it finds. Every route declares a guard and every mutation is audited. Repository changes (the scan job) land as merge requests.

## Auth-model decisions (taken on the standing authorization; say so in the report)
- Reading findings: any member of the project. Dismiss and reopen: project maintainer or organization admin, because dismissing also takes a finding out of the gate.
- The gate: an organization admin sets it, anyone in the organization reads it (mirrors cost limits: a maintainer must not lift what holds applies back, and a merge request cannot, because it lives in the organization row).

## Deviations
- SCAN-7 asked for "a findings tab on the project page". The web app has no project page or tabs, so it is a navigation page with the project picker the Status page uses.
- The page shows Dismiss and Reopen to every member and lets the API refuse (a reporter is told so, nothing changes): the access endpoint has organization actions only.

## Not verified / human gates
- **Nothing ran against a real GitLab.** Assumed and unchecked: that a finding's fingerprint is stable across runs (SCAN-1); that the artifact endpoint and the job name `secret_detection` are as documented (SCAN-3); that the template `Jobs/Secret-Detection.gitlab-ci.yml` exists with a job `secret_detection` in stage `test`, that a key of the main file merges over an included job, that `inherit: default: false` works there, and that its rules run the job on the branches wanted (merge-request pipelines may not) (SCAN-5). The mock's template stand-in and stage check are written from the same assumptions.
- The runners are not listed until worker pools (POOL-4), so the warning always says the executors are "not known".
- SCAN-6 limits: the note can lag the apply (it updates on plan events); a finding stored in the few milliseconds between the count and the claim does not hold that apply; `deny` is organization-wide with no per-project override; projects that do not run the scan are not protected; there is no screen or command for setting the gate (the API only).
- The Playwright journey does not visit the Findings page; no browser run of it.
- Some tests were written with their code and checked by mutation instead of seen red first (core, db, note, CLI; SCAN-5 render and template tests); the run-apply, route and web-page tests were seen red.
- The first whole `bun run check` failed in the web project's typecheck (a `Blob` in SCAN-3's capped read); fixed with a streaming `TextDecoder` and a test. Per-task gates had run only the root `tsc`.
- Changed existing tests: route counts in `authz.test.ts` and `spec.test.ts`; `audit.test.ts` uses `auditPlugin`; the jobs-listing count in `pipeline-runs.test.ts` (1 to 2: SCAN-3 lists jobs once per finished pipeline). The app's route type is at the TypeScript instantiation limit (TS2589): `app.ts` groups three route plugins into `judges`, and the next new routes may need another group.
- `/code-review` and `/security-review` ran once for the whole feature, not per task (results below).

## Review results (once for the whole feature, not per task)
- **`/security-review`:** no high-confidence vulnerability. Below the bar, kept as documented limits: the report is only as trustworthy as the project's own CI (someone who controls that pipeline can leave findings out and lift a `deny` gate), and a tag pipeline is read by its `ref` name, so a tag named like the default branch would be read as that branch.
- **`/code-review`:** 13 findings. Fixed, each seen red first: a `start_line` above the column's 32-bit range would have failed the insert of a whole report (now no line, finding kept); a resolved default-branch finding was reopened, and its fields overwritten, by a feature branch's scan (only a default-branch scan reopens it now); the CLI printed a path, rule and branch with C1/bidi characters unfiltered (now stripped, `--json` unchanged); "1 secret findings are open" (pluralised). Declined on purpose: normalising a rule name (it could carry text taken from a secret into a row). The rest are in "Limits worth knowing": out-of-order events, MR and other refs never auto-resolved, the default branch name is the one the project was added with, an artifact redirect is not followed.
- Follow-ups: POOL-6 gives the `secret_detection` job the pool's tags; POOL-4 passes runner executors to `secretDetectionWarnings`; if GitLab serves artifacts by redirect, `packages/gitlab` needs a same-host-only follow.
