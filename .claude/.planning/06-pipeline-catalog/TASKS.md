# 06 Pipeline Catalog - Tasks

### PIPE-1 - Template manifest and loader  `[x]` S - deps: FND-3
Do: `packages/pipelines` zod schema for the manifest; loader that validates every template under `templates/`; params validated against the manifest's JSON schema.
Done when: tests reject malformed manifests, unknown param types and missing files.

### PIPE-2 - Starter templates  `[x]` M - deps: PIPE-1
Do: `bun-app` (install, typecheck, lint, test, build), `node-app`, `docker-image` (build and push to the GitLab registry).
Done when: each template validates and renders with defaults; snapshots committed.

### PIPE-3 - Layered renderer  `[x]` M - deps: PIPE-1
Do: parse template YAML, substitute scalar placeholders, deep-merge layers, emit deterministic YAML (`yaml` package).
Done when: tests prove precedence of layers, list replacement, that a param containing YAML syntax stays an inert string, and output is byte-stable across runs.

### PIPE-4 - Detection and recommendation  `[ ]` S - deps: PIPE-1, GL-7
Do: map project type tags to templates with a confidence and reason.
Done when: fixture projects (Bun, Node, Docker-only, Terraform, empty) get the expected ranked recommendations.

### PIPE-5 - Validation  `[ ]` M - deps: PIPE-3, GL-3, VAR-4
Do: lint the rendered YAML via GitLab CI lint; check `requiresVariables` exist in the platform for the target environments and report the missing ones.
Done when: tests with the mock cover lint errors, warnings and missing-variable reports.

### PIPE-6 - Apply via MR  `[ ]` M - deps: PIPE-5, GL-2, AUTH-3
Do: `POST /projects/:id/pipeline` creates/updates a branch, commits `.gitlab-ci.yml`, opens or updates one MR with a readable description; store `pipeline_configs`; idempotent on re-run; audited.
Done when: tests cover first run, re-run with unchanged config (no new commit), changed params (MR updated), existing hand-written `.gitlab-ci.yml` (MR shows a diff, nothing overwritten silently). **First real MR is a human gate.**

### PIPE-7 - Fleet upgrade  `[ ]` M - deps: PIPE-6
Do: when a template version is bumped, list pinned projects, dry-run diff each, then open MRs in rate-limited batches with per-project results.
Done when: tests cover dry-run (no writes), partial failure, resume, and the rate limit.

### PIPE-8 - Pipeline status ingestion  `[ ]` M - deps: GL-8, API-2
Do: handle pipeline/job webhooks into `pipeline_runs`; API for latest runs per project/environment with failure reason.
Done when: tests cover out-of-order events, duplicate events and retry of a failed pipeline via the trigger API.

### PIPE-9 - Include mode (post-MVP)  `[ ]` M - deps: PIPE-6
Do: render a thin `.gitlab-ci.yml` using `include:` + inputs against a templates project, selectable per pipeline config, with "eject to inline".
Done when: renders and lints in both modes; switching modes produces a clean MR.
