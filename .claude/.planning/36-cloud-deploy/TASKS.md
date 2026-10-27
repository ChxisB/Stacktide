# 36 Cloud Deploy - Tasks

Cuts: A (CLD-1..2, decision and spike), B (CLD-3..4, the deploy identity), C (CLD-5..9, scripts and wrappers), D (CLD-10..11, GitHub records, promote and rollback), E (CLD-12..15, wiring, CLI, docs, real deploy). CLD-15 is a human gate. Every task is forge-neutral unless it says GitHub or GitLab.

### CLD-1 - ADR-0025: shipped cloud deploy scripts; deployments on GitHub  `[x]` S - deps: BLP-1 (written 2026-10-27 as Proposed; not accepted by anyone; D20 is added to the ROADMAP only after you accept)
Do: write the ADR. Options: (a) one shipped script per cloud, forge wrappers, OIDC identity as a blueprint (recommended); (b) the platform calls Cloud Run/ECS (rejected: invariant 3); (c) install Coolify or Dokploy as the deployer (rejected: server access). State what it amends: ADR-0020 / feature 31's non-goal "Helm, SSH or compose templates shipped by the platform" (cloud-CLI scripts become shipped; Helm, SSH and compose stay out), and **ADR-0019 item 8 for deployments on GitHub** (all its other refusals stay). D1 and invariant 3 do not change. **Human gate; no code.**
Done when: you accept or change it. D20 is added to the ROADMAP only after that.

### CLD-2 - Spike: verify the cloud and OIDC facts we have not read  `[x]` S - deps: CLD-1 (`docs/cloud-deploy-spike.md`, 2026-10-27; eleven items stay unverified and name what checks them)
Do: read-only. Write `docs/cloud-deploy-spike.md`: the exact `gcloud run deploy` and `aws ecs` calls and permissions needed; Artifact Registry and ECR push permissions and image retention; Workload Identity Federation provider settings and the AWS OIDC provider for both GitLab's and GitHub's issuers, with the claim names the condition must use (`sub`, `aud`, protected-ref and environment claims); whether a Cloud Run service can pull from the forge's registry; what Docker the runner needs. Each item verified with a link, or still unverified.
Done when: the doc exists and CLD-3..9 can cite it. Nothing is installed or run.

### CLD-3 - Blueprint: deploy identity, GCP  `[x]` M - deps: CLD-2, BLP-3 (2026-10-27; `gcp/deploy-identity` v1)
Do: add `deploy-identity` (kind) to `BlueprintSchema` and `packages/iac/blueprints/gcp/deploy-identity/`: a workload identity pool and provider for the forge's issuer, a service account allowed to update one named Cloud Run service and write to one named repository, the `sub` condition as an exact string built from the project path and ref or environment. The provider's attribute condition is mandatory and pins the numeric id claim (`repository_id`, or `namespace_id` and `project_id`) as well as the `sub`, built in the form the repository uses (GitHub ref, environment, or the immutable form with ids; spike finding 1 to 3).
Done when: opt-in `terraform validate`; plain tests: no wildcard `sub`, no `roles/owner` or editor, bindings scoped to one service and one repository; the injection test passes through the new fields; `/security-review` run.

### CLD-4 - Blueprint: deploy identity, AWS  `[x]` M - deps: CLD-2, BLP-3 (2026-10-27; `aws/deploy-identity` v1)
Do: `packages/iac/blueprints/aws/deploy-identity/`: an IAM OIDC provider (or a reference to an existing one by id), a role whose trust policy names the exact `sub` and `aud`, and a policy allowing the ECS update calls for one service and the push calls for one ECR repository.
Done when: same tests; no `*` action or resource except those the ECR login call requires, listed in a comment and a test.

### CLD-5 - Script: Cloud Run  `[x]` M - deps: CLD-2 (`packages/pipelines/scripts/deploy-cloud-run.sh`, 2026-10-27; stub CLIs only)
Do: `packages/pipelines/scripts/deploy-cloud-run.sh`: reads only the allowed variables, signs in with the OIDC token (no key file written), builds and pushes the image tagged with the commit SHA, updates the service, waits until it is ready, prints the URL, never echoes a variable.
Done when: a test runs the script under Bun's shell with stub `gcloud` and `docker` on `PATH` and asserts the exact commands, no file under `$HOME` or the workspace named like a key, and a failing stub fails the script; `shellcheck` if installed.

### CLD-6 - Script: ECS  `[x]` M - deps: CLD-2 (`deploy-ecs.sh`, 2026-10-27; the AWS service module is now v2, see LOG)
Do: `deploy-ecs.sh`: assume the role with the OIDC token, ECR login, build and push (the repository is `IMMUTABLE`: check the tag first and skip the push when it exists, spike finding 5), register a new task definition revision with the new image (copying the current one), update the service, wait for steady state, print the URL from the service output. Also add `lifecycle { ignore_changes = [task_definition] }` to `aws_ecs_service.this` in the AWS service module (spike finding 4: without it the next apply puts the placeholder back; the GCP module already ignores the image), with a plain test.
Done when: the same kind of stubbed test with `aws` and `docker`, including a failing wait.

### CLD-7 - GitLab template: cloud-run  `[x]` S - deps: CLD-5 (`templates/cloud-run/1.0.0`, 2026-10-27)
Do: `packages/pipelines/templates/cloud-run/` beside `docker-deploy`: a job that requests an `id_token`, sets the allowed variables, runs the script, declares `environment:` with the platform slug.
Done when: a snapshot test; a test that fails on any variable outside the allowed list; the existing template tests unchanged.

### CLD-8 - GitLab template: ecs  `[x]` S - deps: CLD-6 (`templates/ecs/1.0.0`, 2026-10-27)
Do: the same for ECS.
Done when: same tests.

### CLD-9 - GitHub workflows: cloud-run and ecs  `[x]` M - deps: CLD-5, CLD-6, FRG-31 (a `workflow.yml` beside each template, as docker-image has; 2026-10-27)
Do: the workflow files for both clouds in `packages/github` (or where the stack workflow lives): `permissions: id-token: write`, `environment:` equal to the slug, the allowed inputs, the shipped script. Delivered by the onboarding PR, never a default branch.
Done when: snapshots; a test that parses the YAML and fails on a secret reference, a `pull_request_target` trigger, or any permission broader than needed; the onboarding PR test on the mock GitHub includes the new file.

### CLD-10 - GitHub deployment records  `[x]` M - deps: CLD-1, CLD-9 (2026-10-27; adapter, webhook, handler and refresh; see LOG)
Do: implement `deployments.list/get` on the GitHub adapter as designed in `docs/forge-seam.md`; map the `deployment_status` webhook into the same events GitLab's produce; set the `deployments` capability flag true for GitHub; update `docs/forge-seam.md`, `docs/forges.md` and the refusal list.
Done when: contract tests run over both mock forges (the existing GitLab ones unchanged); webhook test for success, failure, in-progress; feature 31's route tests green on a GitHub project; a test that every other ADR-0019 refusal still refuses.

### CLD-11 - Promote and rollback on GitHub  `[x]` M - deps: CLD-10 (2026-10-27; see LOG; `/security-review` pending, covering CLD-3, 4, 10 and 11)
Do: on GitHub, promote and rollback start a `workflow_dispatch` of the deploy workflow with the three inputs, correlated by run name; the audit event and the guards are feature 31's.
Done when: mock tests for promote, rollback to a recorded tag, a tag not in the records (422), a protected environment without an approved change request (refused), a second start while one runs (409); `/security-review` run.

### CLD-12 - A service resource knows how to deploy  `[ ]` M - deps: BLP-14, BLP-17, CLD-7, CLD-8
Do: from a `service` resource, derive the deploy inputs (cloud, region, project or account, service, repository, identity) deterministically from its inputs and its stack's outputs allowed in BLP-17; `orch deploy setup <resource>` proposes the template include (GitLab) or confirms the workflow file (GitHub) through the forge seam. Any new column is additive and said so in the task log.
Done when: tests that the derived values equal the module's own naming for both clouds (one function used by both, with a test), a proposal on both mock forges, and a leak test on the derived values.

### CLD-13 - CLI: deploy on both forges  `[ ]` S - deps: CLD-11, CLD-12
Do: `orch deploy run|promote|rollback|ls` already exist for GitLab (feature 31); make them forge-neutral and add `orch deploy setup`.
Done when: command tests over both mock forges; the existing GitLab tests unchanged.

### CLD-14 - Docs and demo  `[ ]` S - deps: CLD-13
Do: `docs/cloud-deploy.md` (what runs where, the identity and the bootstrap steps, what the platform holds (nothing), what it will not do, rollback limits); update `docs/deployments.md` and ADR-0020's consequences; a deployed service in the demo seed.
Done when: `bun run check` is green.

### CLD-15 - First real deploy  `[!]` M - deps: CLD-14, BLP-21 - human gate
Do: bootstrap the deploy identity by hand in a sandbox GCP project and AWS account, deploy a hello app through a GitLab project and a GitHub repository, roll back, and record the times. Differences go into the SPEC and `docs/cloud-deploy-spike.md`.
Done when: you ran it. Blocked until then.

### Held (not scheduled)
CLD-16 previews with Cloud Run revision tags (and a per-PR service on ECS). Added only if you say yes to question 5.
