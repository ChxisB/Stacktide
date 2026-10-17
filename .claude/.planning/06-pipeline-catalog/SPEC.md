# 06 Pipeline Catalog - Spec
Prefix: PIPE · Milestone: M2 · Status: todo

## Goal
Set up CI/CD for a GitLab project in minutes: detect what it is, pick a template, preview the result, and land it as an MR - then keep a fleet of projects up to date.

## Scope
Template format + loader; starter templates; layered renderer; project detection; validation (GitLab lint + required variables); apply via MR; bulk template upgrades; pipeline status ingestion; include-mode (later).

## Non-goals
IaC-specific pipelines (IAC-4 generates those), running pipelines ourselves (GitLab does).

## Design
- Template = `templates/<name>/<version>/manifest.json` (name, description, params JSON-schema, `detects`, `requiresVariables`) + `pipeline.yml` (a YAML document with `{{ params.x }}` placeholders).
- Substitution happens on **parsed YAML scalars only**, never raw text, so params cannot break structure or inject jobs.
- Layers (Atmos/Terraspace-style): template defaults -> org defaults -> project params -> per-environment overrides. Maps deep-merge; lists replace (shortcut: add an explicit append marker only when a template needs it).
- Output is deterministic and comment-stable so MR diffs are small.
- Delivery (D8): inline render of a full `.gitlab-ci.yml` via MR. We store `pipeline_configs(project_id, template, version, params, mr_url, rendered_hash)`. Never push to the default branch.
- Fleet ops (Terramate/Atmos spirit): a new template version lists pinned projects and opens MRs in rate-limited batches, dry-run first.

## Acceptance
For an imported Bun project: detection recommends `bun-app`, the wizard/API renders and lints the pipeline, flags missing required variables, opens one MR (re-running updates it rather than duplicating), and pipeline status shows up after merge.

## Risks / human gates
First MR against a real project. Bulk upgrade (PIPE-7) writes to many repos - dry-run list and explicit confirmation required.
